// Settings dialog (⌘, / Ctrl+,). Every control applies immediately through
// `apply`; there is no OK/Cancel step. Values persist with the session.

import { api, DOCS_URL, isMac, openUrl } from './backend';
import { DIALECTS, DialectId } from './languages';
import { h, setModalOpen } from './ui';
import { DEFAULT_SETTINGS, Settings } from './workbench';

export type SettingKey = keyof Settings;

export interface SettingsHooks {
  settings: Settings;
  apply<K extends SettingKey>(key: K, value: Settings[K]): void;
  /** Launch-to-first-screen time measured at boot (0 = unknown). */
  startupMs: number;
  ddl: DdlHooks;
}

export interface DdlHooks {
  /** Rule count and load errors of the current ruleset. */
  status(): { path: string; count: number; errors: string[] };
  browse(): Promise<string | null>;
  /** Writes the template to the settings folder (if missing) and returns its path. */
  createTemplate(): Promise<string | null>;
  open(path: string): void;
  reload(): Promise<void>;
}

type Section = 'editor' | 'sql' | 'ddl' | 'files' | 'about';
const SECTIONS: [Section, string][] = [
  ['editor', '편집기'],
  ['sql', 'SQL'],
  ['ddl', 'DDL 검토'],
  ['files', '파일'],
  ['about', '정보'],
];

let lastSection: Section = 'editor';
let open = false;

export function openSettings(hooks: SettingsHooks) {
  if (open) return;
  open = true;
  setModalOpen(true);
  const prevFocus = document.activeElement as HTMLElement | null;
  const s = hooks.settings;
  let preview: HTMLElement | null = null;

  // ---- controls ----------------------------------------------------------------
  const row = (label: string, hint: string | null, control: HTMLElement) =>
    h(
      'label',
      { class: 'set-row' },
      h('div', { class: 'set-label' }, h('div', {}, label), hint ? h('div', { class: 'set-hint' }, hint) : null),
      h('div', { class: 'set-control' }, control),
    );

  const select = <K extends SettingKey>(key: K, options: [Settings[K], string][]) => {
    const el = h('select', { class: 'set-select' });
    for (const [v, label] of options) el.append(h('option', { value: String(v) }, label));
    el.value = String(s[key]);
    el.addEventListener('change', () => {
      const opt = options.find(([v]) => String(v) === el.value);
      if (!opt) return;
      hooks.apply(key, opt[0]);
      if (key === 'sqlStyle' && preview) preview.textContent = previewSql(s.sqlStyle);
    });
    return el;
  };

  const toggle = (key: SettingKey) => {
    const el = h('input', { type: 'checkbox', class: 'set-check' }) as HTMLInputElement;
    el.checked = !!s[key];
    el.addEventListener('change', () => hooks.apply(key, el.checked as never));
    return el;
  };

  const number = (key: 'fontSize' | 'largeFileMB', min: number, max: number, unit: string) => {
    const el = h('input', { type: 'number', class: 'set-num', min, max, step: 1 }) as HTMLInputElement;
    el.value = String(s[key]);
    el.addEventListener('change', () => {
      const n = Math.round(Number(el.value));
      if (!Number.isFinite(n)) return (el.value = String(s[key]));
      const v = Math.min(max, Math.max(min, n));
      el.value = String(v);
      hooks.apply(key, v);
    });
    return h('span', { class: 'set-numwrap' }, el, h('span', { class: 'set-unit' }, unit));
  };

  const text = (key: 'fontFamily', placeholder: string) => {
    const el = h('input', { type: 'text', class: 'set-text', placeholder, spellcheck: 'false' }) as HTMLInputElement;
    el.value = s[key];
    let t = 0;
    el.addEventListener('input', () => {
      clearTimeout(t);
      t = window.setTimeout(() => hooks.apply(key, el.value.trim()), 250);
    });
    return el;
  };

  // ---- sections ----------------------------------------------------------------
  const build: Record<Section, () => HTMLElement[]> = {
    editor: () => [
      row('글꼴', '비워 두면 기본 고정폭 글꼴. 쉼표로 여러 개 지정', text('fontFamily', 'D2Coding, JetBrains Mono')),
      row('글꼴 크기', isMac ? '⌘+ / ⌘- 로도 조절' : 'Ctrl++ / Ctrl+- 로도 조절', number('fontSize', 9, 28, 'px')),
      row(
        '들여쓰기',
        '문서 정렬과 Tab 키에 사용',
        select('indent', [
          [2, '공백 2칸'],
          [4, '공백 4칸'],
          [8, '공백 8칸'],
        ]),
      ),
      row('자동 줄바꿈', null, toggle('wrap')),
      row(
        '공백 문자 표시',
        null,
        select('whitespace', [
          ['none', '표시 안 함'],
          ['trailing', '줄 끝 공백만'],
          ['all', '모두'],
        ]),
      ),
    ],
    sql: () => [
      row(
        'SQL 방언',
        '구문 강조와 자동완성 키워드',
        select(
          'dialect',
          (Object.keys(DIALECTS) as DialectId[]).map((d) => [d, DIALECTS[d].label]),
        ),
      ),
      row(
        '정렬 스타일',
        `문서 정렬(${isMac ? '⇧⌥F' : 'Shift+Alt+F'}) 결과. 키워드 대소문자는 입력한 그대로 유지`,
        select('sqlStyle', [
          ['left', '왼쪽 정렬'],
          ['river', '리버 (키워드 오른쪽 맞춤)'],
        ]),
      ),
      row(
        '자동완성 키워드',
        '자동완성으로 넣는 키워드의 대소문자',
        select('sqlKeywordCase', [
          ['upper', '대문자 (SELECT)'],
          ['lower', '소문자 (select)'],
        ]),
      ),
      (preview = h('pre', { class: 'set-preview' }, previewSql(s.sqlStyle))),
    ],
    files: () => [
      row(
        '자동 저장',
        '경로가 있는 파일만 저장합니다 (새 파일 제외)',
        select('autoSave', [
          ['off', '끔'],
          ['delay', '입력 후 1초'],
          ['blur', '창·편집기에서 벗어날 때'],
        ]),
      ),
      row('저장 시 줄 끝 공백 제거', 'Markdown 문서는 제외 (줄 끝 공백 2칸 = 줄바꿈)', toggle('trimTrailing')),
      row('저장 시 마지막 줄바꿈 추가', null, toggle('finalNewline')),
      row('외부 변경 감지', '다른 프로그램이 바꾼 파일을 바로 다시 읽기', toggle('watch')),
      row(
        '대용량 파일 기준',
        '이보다 큰 파일은 구문 강조 없이 엽니다 (새로 여는 파일부터)',
        number('largeFileMB', 1, 200, 'MB'),
      ),
    ],
    ddl: () => {
      const d = hooks.ddl;
      const path = h('input', {
        type: 'text',
        class: 'set-text set-wide',
        placeholder: '규칙 파일 경로 (.yaml) — 비우면 끔',
        spellcheck: 'false',
      }) as HTMLInputElement;
      path.value = s.ddlRulesPath;
      const status = h('div', { class: 'set-ddl-status' });
      const paint = () => {
        const st = d.status();
        status.replaceChildren();
        if (!st.path) status.append(h('span', { class: 'set-hint' }, '규칙 파일이 없어 DDL 검토가 꺼져 있습니다.'));
        else
          status.append(
            h(
              'span',
              { class: st.errors.length ? 'set-warn' : 'set-ok' },
              `규칙 ${st.count}개 적용 중` + (st.errors.length ? ` · 오류 ${st.errors.length}개` : ''),
            ),
          );
        if (st.errors.length) {
          const ul = h('ul', { class: 'set-errors' });
          for (const e of st.errors.slice(0, 20)) ul.append(h('li', {}, e));
          status.append(ul);
        }
      };
      const setPath = async (p: string) => {
        path.value = p;
        hooks.apply('ddlRulesPath', p);
        await d.reload();
        paint();
      };
      path.addEventListener('change', () => setPath(path.value.trim()));
      const btn = (label: string, fn: () => void, primary = false) =>
        h('button', { class: 'btn small' + (primary ? ' primary' : ''), onclick: fn }, label);
      const actions = h(
        'div',
        { class: 'set-actions' },
        btn('찾아보기…', async () => {
          const p = await d.browse();
          if (p) setPath(p);
        }),
        btn('템플릿 만들기', async () => {
          const p = await d.createTemplate();
          if (p) {
            await setPath(p);
            d.open(p);
          }
        }),
        btn('편집기로 열기', () => path.value && d.open(path.value)),
        btn('다시 읽기', async () => {
          await d.reload();
          paint();
        }),
        btn('규칙 작성 가이드 ↗', () => openUrl(DOCS_URL + 'ddl-rules.html')),
      );
      paint();
      return [
        h(
          'p',
          { class: 'set-intro' },
          'SQL 문서의 CREATE / ALTER / CREATE INDEX / DROP 문을 규칙 파일(YAML) 기준으로 검토해 밑줄과 문제 목록으로 보여줍니다. ' +
            '규칙은 회사·팀 기준이므로 앱에 들어 있지 않습니다 — 팀 공용 폴더나 사내 저장소의 파일을 지정하세요.',
        ),
        h('div', { class: 'set-block' }, h('div', { class: 'set-label' }, '규칙 파일'), path, actions, status),
        h(
          'p',
          { class: 'set-intro' },
          '대상 DB는 상태 표시줄의 SQL 방언(MySQL · PostgreSQL · Oracle)을 따릅니다. 오른쪽 검토 패널은 ' +
            (isMac ? '⇧⌘M' : 'Ctrl+Shift+M') +
            ' (상태 표시줄 DDL 항목 클릭), 다음·이전 문제는 F8 / ⇧F8. 규칙 파일을 저장하면 바로 다시 적용됩니다.',
        ),
      ];
    },
    about: () => {
      const startup = h('b', {}, hooks.startupMs ? hooks.startupMs + ' ms' : '-');
      const dir = h('code', { class: 'set-path' }, '…');
      api
        .SettingsDir()
        .then((d) => (dir.textContent = d || '-'))
        .catch(() => (dir.textContent = '-'));
      const reset = h('button', { class: 'btn' }, '모든 설정 초기화');
      reset.addEventListener('click', () => {
        for (const k of Object.keys(DEFAULT_SETTINGS) as SettingKey[])
          if (k !== 'ddlRulesPath') hooks.apply(k, DEFAULT_SETTINGS[k] as never);
        show('editor');
      });
      return [
        h(
          'div',
          { class: 'set-about' },
          h('div', { class: 'set-app' }, 'ArgusCode', h('span', { class: 'set-ver' }, 'v' + __APP_VERSION__)),
          h('div', { class: 'set-hint' }, 'SQL · Markdown · JSON · YAML · JS · Shell 경량 편집기'),
          h('button', { class: 'btn small set-docs', onclick: () => openUrl(DOCS_URL) }, '온라인 문서 ↗'),
        ),
        row('시작 시간', '실행부터 첫 화면까지', startup),
        row('설정 저장 위치', 'session.json — 설정과 열린 탭, 최근 항목', dir),
        row('초기화', '편집기·SQL·파일 설정을 기본값으로 (열린 탭은 유지)', reset),
      ];
    },
  };

  // ---- layout ------------------------------------------------------------------
  const nav = h('div', { class: 'set-nav' });
  const body = h('div', { class: 'set-body' });
  const navBtns = new Map<Section, HTMLElement>();
  for (const [id, label] of SECTIONS) {
    const b = h('button', { class: 'set-nav-item', onclick: () => show(id) }, label);
    navBtns.set(id, b);
    nav.append(b);
  }
  function show(id: Section) {
    lastSection = id;
    for (const [k, b] of navBtns) b.classList.toggle('active', k === id);
    body.replaceChildren(h('h2', { class: 'set-h' }, SECTIONS.find(([k]) => k === id)![1]), ...build[id]());
  }

  const closeBtn = h('button', { class: 'set-close', title: '닫기 (Esc)', onclick: () => close() }, '✕');
  const dialog = h(
    'div',
    { class: 'modal settings', role: 'dialog', 'aria-label': '설정' },
    h('div', { class: 'set-top' }, h('span', {}, '설정'), closeBtn),
    h('div', { class: 'set-main' }, nav, body),
  );
  const overlay = h('div', { class: 'modal-overlay' }, dialog);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape' || (mod && (e.key === ',' || e.key === 'w'))) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  function close() {
    open = false;
    setModalOpen(false);
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.();
  }

  show(lastSection);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  navBtns.get(lastSection)?.focus();
}

/** Small static sample so the style choice is visible without formatting a file. */
function previewSql(style: 'left' | 'river'): string {
  return style === 'left'
    ? 'Select\n  o.member_id,\n  sum(o.amount) as total\nFrom orders o\nWhere o.created_at >= ?\n  and o.status = 1'
    : 'select o.member_id,\n       sum(o.amount) as total\n  from orders o\n where o.created_at >= ?\n   and o.status = 1';
}
