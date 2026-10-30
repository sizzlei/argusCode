// Settings dialog (⌘, / Ctrl+,). Every control applies immediately through
// `apply`; there is no OK/Cancel step. Values persist with the session.

import { api, DOCS_URL, isMac, openUrl } from './backend';
import { DIALECTS, DialectId } from './languages';
import { h, setModalOpen } from './ui';
import { DEFAULT_SETTINGS, Settings } from './workbench';
import {
  COMMANDS,
  comboOf,
  diffFromDefaults,
  effectiveKeys,
  isAssignable,
  keyCapture,
  keyLabel,
  RESERVED_KEYS,
  shortcut,
} from './keybindings';

export type SettingKey = keyof Settings;

export interface SettingsHooks {
  settings: Settings;
  apply<K extends SettingKey>(key: K, value: Settings[K]): void;
  /** Launch-to-first-screen time measured at boot (0 = unknown). */
  startupMs: number;
  ddl: DdlHooks;
  updates: { check(): void; notes(): void };
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

type Section = 'editor' | 'sql' | 'ddl' | 'files' | 'keys' | 'about';
const SECTIONS: [Section, string][] = [
  ['editor', '편집기'],
  ['sql', 'SQL'],
  ['ddl', 'DDL 검토'],
  ['files', '파일'],
  ['keys', '단축키'],
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
      row(
        '테마',
        isMac ? '창 제목 표시줄은 다음 실행부터 바뀝니다' : null,
        select('theme', [
          ['dark', '다크'],
          ['light', '라이트'],
        ]),
      ),
      row('글꼴', '비워 두면 기본 고정폭 글꼴. 쉼표로 여러 개 지정', text('fontFamily', 'D2Coding, JetBrains Mono')),
      row(
        '글꼴 크기',
        shortcut('zoom.in') ? `${shortcut('zoom.in')} / ${shortcut('zoom.out')} 로도 조절` : null,
        number('fontSize', 9, 28, 'px'),
      ),
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
        `문서 정렬${shortcut('format') ? `(${shortcut('format')})` : ''} 결과. 키워드 대소문자는 입력한 그대로 유지`,
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
          'SQL 문서의 CREATE / ALTER / CREATE INDEX / DROP 문을 규칙 파일(YAML) 기준으로 검토해 밑줄과 오른쪽 검토 패널로 보여줍니다. ' +
            '규칙은 회사·팀 기준이므로 앱에 들어 있지 않습니다 — 팀 공용 폴더나 사내 저장소의 파일을 지정하세요.',
        ),
        h('div', { class: 'set-block' }, h('div', { class: 'set-label' }, '규칙 파일'), path, actions, status),
        row(
          '온라인 DDL 영향 표시',
          'ALTER / CREATE INDEX가 테이블을 재구성하거나 쓰기를 막는지 검토 패널에 함께 보여줍니다 (규칙 파일 없이도 동작)',
          toggle('ddlImpact'),
        ),
        h(
          'p',
          { class: 'set-intro' },
          '대상 DB는 상태 표시줄의 SQL 방언(MySQL · PostgreSQL · Oracle)을 따릅니다. 오른쪽 검토 패널은 ' +
            (shortcut('problems.open') ? shortcut('problems.open') + ' 또는 ' : '') +
            '상태 표시줄 DDL 항목 클릭, 다음·이전 문제는 F8 / ⇧F8. 규칙 파일을 저장하면 바로 다시 적용됩니다.',
        ),
      ];
    },
    keys: () => keySection(hooks, () => show('keys')),
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
        row(
          '업데이트',
          `현재 v${__APP_VERSION__} · 새 버전을 내려받아 설치하고 다시 시작합니다`,
          h(
            'span',
            { class: 'set-actions inline' },
            h('button', { class: 'btn small', onclick: () => hooks.updates.check() }, '업데이트 확인'),
            h('button', { class: 'btn small', onclick: () => hooks.updates.notes() }, '릴리스 노트'),
          ),
        ),
        row('시작할 때 업데이트 확인', '새 버전이 있으면 알림으로 알려줍니다 (몇 시간에 한 번)', toggle('updateCheck')),
        row('시작 시간', '실행부터 첫 화면까지', startup),
        row('설정 저장 위치', 'session.json — 설정과 열린 탭, 최근 항목', dir),
        row('초기화', '편집기·SQL·파일·단축키 설정을 기본값으로 (열린 탭과 DDL 규칙 파일은 유지)', reset),
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
    stopCapture?.();
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

// ---- shortcuts -----------------------------------------------------------------------

/** Ends an in-progress shortcut recording (set while recording). */
let stopCapture: (() => void) | null = null;

function keySection(hooks: SettingsHooks, rerender: () => void): HTMLElement[] {
  const keys = () => effectiveKeys(hooks.settings.keybindings);
  const save = (k: Record<string, string>) => hooks.apply('keybindings', diffFromDefaults(k));
  const notice = h('div', { class: 'set-key-notice' });
  const say = (text: string, warn = false) => {
    notice.textContent = text;
    notice.className = 'set-key-notice' + (warn ? ' warn' : '') + (text ? ' show' : '');
  };
  const filter = h('input', {
    type: 'search',
    class: 'set-text set-key-filter',
    placeholder: '명령 또는 단축키 검색',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const list = h('div', { class: 'set-keys' });

  const record = (id: string, btn: HTMLElement) => {
    if (btn.classList.contains('recording')) return;
    stopCapture?.();
    btn.classList.add('recording');
    btn.textContent = '키 조합을 누르세요…';
    say('Esc: 취소 · ⌫(Backspace): 단축키 지우기');
    keyCapture.active = true;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.isComposing) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if (e.key === 'Escape' && plain) return stop(true);
      if ((e.key === 'Backspace' || e.key === 'Delete') && plain) {
        const k = keys();
        k[id] = '';
        save(k);
        stop(false);
        say(`'${label(id)}' 단축키를 지웠습니다.`);
        return;
      }
      const combo = comboOf(e);
      if (!combo) return; // modifier only — keep waiting
      if (!isAssignable(combo)) {
        say(
          `${keyLabel(combo)}는 글자 입력용입니다. ${isMac ? '⌘ / ⌥ / ⌃' : 'Ctrl / Alt'}와 함께 누르거나 F 키를 쓰세요.`,
          true,
        );
        return;
      }
      const k = keys();
      const msgs: string[] = [];
      for (const c of COMMANDS) {
        if (c.id !== id && k[c.id] === combo) {
          k[c.id] = '';
          msgs.push(`'${c.label}'에서 쓰던 ${keyLabel(combo)}를 해제했습니다.`);
        }
      }
      if (RESERVED_KEYS[combo])
        msgs.push(`${keyLabel(combo)}는 편집기의 '${RESERVED_KEYS[combo]}' 대신 이 명령을 실행합니다.`);
      k[id] = combo;
      save(k);
      stop(false);
      say(msgs.join(' '), msgs.length > 0);
    };
    const onDown = (e: MouseEvent) => {
      if (e.target !== btn) stop(true);
    };
    const stop = (cancelled: boolean) => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
      // Let the key-up of the recorded combo pass before commands run again.
      setTimeout(() => (keyCapture.active = false), 200);
      stopCapture = null;
      if (cancelled) say('');
      paint();
    };
    stopCapture = () => stop(true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
  };

  const label = (id: string) => COMMANDS.find((c) => c.id === id)?.label ?? id;

  const paint = () => {
    const k = keys();
    const q = filter.value.trim().toLowerCase();
    list.replaceChildren();
    let group = '';
    for (const c of COMMANDS) {
      const combo = k[c.id] ?? '';
      const shown = keyLabel(combo);
      if (q && !(c.label.toLowerCase().includes(q) || c.group.includes(q) || shown.toLowerCase().includes(q))) continue;
      if (c.group !== group) {
        group = c.group;
        list.append(h('div', { class: 'set-keys-group' }, group));
      }
      const btn = h('button', { class: 'set-key' + (combo ? '' : ' empty'), title: '눌러서 바꾸기' }, shown || '없음');
      btn.addEventListener('click', () => record(c.id, btn));
      const changed = combo !== c.key;
      const reset = h(
        'button',
        {
          class: 'set-key-reset' + (changed ? '' : ' hidden'),
          title: c.key ? `기본값 ${keyLabel(c.key)}로 되돌리기` : '기본값(없음)으로 되돌리기',
        },
        '↺',
      );
      reset.addEventListener('click', () => {
        const kk = keys();
        kk[c.id] = c.key;
        // The default may be taken by another command now.
        const other = c.key ? COMMANDS.find((o) => o.id !== c.id && kk[o.id] === c.key) : undefined;
        if (other) {
          kk[other.id] = '';
          say(`'${other.label}'에서 쓰던 ${keyLabel(c.key)}를 해제했습니다.`, true);
        } else say('');
        save(kk);
        paint();
      });
      list.append(
        h(
          'div',
          { class: 'set-key-row' + (changed ? ' changed' : '') },
          h('span', { class: 'set-key-label' }, c.label),
          btn,
          reset,
        ),
      );
    }
    if (!list.childElementCount) list.append(h('div', { class: 'set-hint' }, '일치하는 명령이 없습니다.'));
  };
  filter.addEventListener('input', paint);
  paint();

  const resetAll = h('button', { class: 'btn small' }, '모두 기본값으로');
  resetAll.addEventListener('click', () => {
    hooks.apply('keybindings', {});
    say('');
    rerender();
  });
  return [
    h(
      'p',
      { class: 'set-intro' },
      '단축키 칸을 누른 뒤 새 키 조합을 누르세요. 메뉴와 우클릭 메뉴에도 바로 반영됩니다. ' +
        '이미 다른 명령이 쓰던 조합이면 그 명령의 단축키는 해제됩니다. ' +
        '복사·붙여넣기·실행 취소·찾기 같은 편집기 기본 키와 편집 그룹 이동(' +
        (isMac ? '⌘1~4' : 'Ctrl+1~4') +
        ')은 그대로 동작합니다.',
    ),
    h('div', { class: 'set-key-tools' }, filter, resetAll),
    notice,
    list,
  ];
}

/** Small static sample so the style choice is visible without formatting a file. */
function previewSql(style: 'left' | 'river'): string {
  return style === 'left'
    ? 'Select\n  o.member_id,\n  sum(o.amount) as total\nFrom orders o\nWhere o.created_at >= ?\n  and o.status = 1'
    : 'select o.member_id,\n       sum(o.amount) as total\n  from orders o\n where o.created_at >= ?\n   and o.status = 1';
}
