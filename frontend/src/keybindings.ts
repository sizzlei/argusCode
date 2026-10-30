// App command shortcuts: defaults, user overrides (Settings → 단축키),
// key-event → combo conversion and display labels.
//
// Combo format: lower-case parts joined by "+", modifiers in the order
// mod, ctrl, shift, alt, then the key — e.g. "mod+shift+m", "shift+alt+f".
// "mod" is ⌘ on macOS and Ctrl elsewhere; "ctrl" is the macOS Control key
// (and Ctrl+Tab on Windows). The native menu gets the same combos through
// App.SetKeybindings (internal/keymap converts them to accelerators).
//
// No DOM or Wails imports, so it can be unit-tested with plain Node.

export interface CommandInfo {
  id: string;
  label: string;
  group: string;
  /** Default combo ('' = none). */
  key: string;
  /** Has an item in the native menu (its accelerator follows the binding). */
  menu?: boolean;
}

export const COMMANDS: CommandInfo[] = [
  { id: 'file.new', label: '새 파일', group: '파일', key: 'mod+n', menu: true },
  { id: 'file.open', label: '파일 열기…', group: '파일', key: 'mod+o', menu: true },
  { id: 'folder.open', label: '폴더 열기…', group: '파일', key: 'mod+shift+o', menu: true },
  { id: 'file.save', label: '저장', group: '파일', key: 'mod+s', menu: true },
  { id: 'file.saveAs', label: '다른 이름으로 저장…', group: '파일', key: 'mod+shift+s', menu: true },
  { id: 'file.saveAll', label: '모두 저장', group: '파일', key: 'mod+alt+s', menu: true },
  { id: 'tab.close', label: '탭 닫기', group: '파일', key: 'mod+w', menu: true },
  { id: 'app.settings', label: '설정…', group: '파일', key: 'mod+,', menu: true },
  { id: 'app.checkUpdate', label: '업데이트 확인…', group: '파일', key: '', menu: true },

  { id: 'quickOpen', label: '빠른 열기…', group: '이동', key: 'mod+p', menu: true },
  { id: 'view.explorer', label: '탐색기', group: '이동', key: 'mod+shift+e', menu: true },
  { id: 'view.search', label: '폴더에서 찾기…', group: '이동', key: 'mod+shift+f', menu: true },
  { id: 'view.outline', label: '개요', group: '이동', key: 'mod+alt+o', menu: true },
  { id: 'sidebar.toggle', label: '사이드바 보이기/숨기기', group: '이동', key: 'mod+b', menu: true },
  { id: 'tab.next', label: '다음 탭', group: '이동', key: 'ctrl+tab' },
  { id: 'tab.prev', label: '이전 탭', group: '이동', key: 'ctrl+shift+tab' },
  { id: 'pane.split', label: '오른쪽으로 분할', group: '이동', key: 'mod+\\', menu: true },
  { id: 'pane.next', label: '다음 편집 그룹으로 이동', group: '이동', key: 'mod+k', menu: true },

  { id: 'format', label: '문서 정렬', group: '도구', key: 'shift+alt+f', menu: true },
  { id: 'md.preview', label: 'Markdown 미리보기', group: '도구', key: 'mod+shift+v', menu: true },
  { id: 'plan.toggle', label: '실행계획 / 데드락 보기', group: '도구', key: 'mod+alt+e', menu: true },
  { id: 'problems.open', label: 'DDL 검토 패널', group: '도구', key: 'mod+shift+m', menu: true },
  { id: 'sql.rollback', label: '롤백 스크립트 만들기', group: '도구', key: '', menu: true },
  { id: 'mongo.toShell', label: 'mongosh 쿼리로 변환', group: '도구', key: '', menu: true },
  { id: 'data.convert', label: 'JSON ↔ YAML 변환', group: '도구', key: '' },
  { id: 'data.sortKeys', label: '키 이름순 정렬 (JSON / YAML)', group: '도구', key: '' },
  { id: 'data.minify', label: 'JSON 한 줄로 압축', group: '도구', key: '' },
  { id: 'diff.saved', label: '저장된 버전과 비교', group: '도구', key: '', menu: true },
  { id: 'diff.tabs', label: '다른 탭과 비교…', group: '도구', key: '', menu: true },

  { id: 'zoom.in', label: '확대', group: '글꼴 크기', key: 'mod+=', menu: true },
  { id: 'zoom.out', label: '축소', group: '글꼴 크기', key: 'mod+-', menu: true },
  { id: 'zoom.reset', label: '원래 크기', group: '글꼴 크기', key: 'mod+0', menu: true },
];

export const DEFAULT_KEYS: Record<string, string> = Object.fromEntries(COMMANDS.map((c) => [c.id, c.key]));

/**
 * Editor (CodeMirror) and system keys. A command may still be bound to one,
 * but the settings screen warns that it replaces the editor's behaviour.
 */
export const RESERVED_KEYS: Record<string, string> = {
  'mod+z': '실행 취소',
  'mod+shift+z': '다시 실행',
  'mod+y': '다시 실행',
  'mod+x': '잘라내기',
  'mod+c': '복사',
  'mod+v': '붙여넣기',
  'mod+a': '모두 선택',
  'mod+f': '찾기',
  'mod+g': '다음 찾기',
  'mod+shift+g': '이전 찾기',
  'mod+alt+g': '줄로 이동',
  'mod+/': '주석 토글',
  'mod+d': '다음 같은 단어 선택',
  'mod+l': '줄 선택',
  'mod+shift+a': '현재 문장 선택 (SQL)',
  'mod+[': '내어쓰기',
  'mod+]': '들여쓰기',
  'mod+1': '편집 그룹 1',
  'mod+2': '편집 그룹 2',
  'mod+3': '편집 그룹 3',
  'mod+4': '편집 그룹 4',
  'mod+q': '종료',
  f8: '다음 문제',
  'shift+f8': '이전 문제',
  f12: '정의로 이동 (SQL)',
};

/** Current bindings (defaults + overrides); '' = unbound. Updated by setBindings. */
let current: Record<string, string> = { ...DEFAULT_KEYS };
let isMacPlatform = false;

export function setPlatform(mac: boolean) {
  isMacPlatform = mac;
}

/** Defaults with the user's overrides applied; unknown commands are ignored. */
export function effectiveKeys(overrides: Record<string, string> | undefined): Record<string, string> {
  const out = { ...DEFAULT_KEYS };
  for (const [id, combo] of Object.entries(overrides ?? {})) {
    if (id in out && typeof combo === 'string') out[id] = normalizeCombo(combo);
  }
  return out;
}

export function setBindings(keys: Record<string, string>) {
  current = { ...keys };
}

export function bindings(): Record<string, string> {
  return current;
}

/** Combo → command lookup for the keydown handler. */
export function keymapOf(keys: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of COMMANDS) {
    const k = keys[c.id];
    if (k && !m.has(k)) m.set(k, c.id);
  }
  // "+" typed with Shift on most layouts.
  if (keys['zoom.in'] === 'mod+=' && !m.has('mod++')) m.set('mod++', 'zoom.in');
  return m;
}

/** Overrides that differ from the defaults (what is stored in settings). */
export function diffFromDefaults(keys: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of COMMANDS) if ((keys[c.id] ?? '') !== c.key) out[c.id] = keys[c.id] ?? '';
  return out;
}

const MOD_ORDER = ['mod', 'ctrl', 'shift', 'alt'];

/** Canonical order of the modifier parts. */
export function normalizeCombo(combo: string): string {
  if (!combo) return '';
  const c = combo.toLowerCase().trim();
  const plus = c.endsWith('++');
  const parts = (plus ? c.slice(0, -2) : c).split('+').filter(Boolean);
  const key = plus ? '+' : (parts.pop() ?? '');
  const mods = MOD_ORDER.filter((m) => parts.includes(m));
  return [...mods, key].join('+');
}

const CODE_KEYS: Record<string, string> = {
  Backslash: '\\',
  Equal: '=',
  Minus: '-',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Space: 'space',
};

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Combo of a keydown event; null for a lone modifier key. */
export function comboOf(e: KeyLike, mac = isMacPlatform): string | null {
  if (['Meta', 'Control', 'Shift', 'Alt', 'AltGraph', 'CapsLock', 'Process', 'Dead'].includes(e.key)) return null;
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (mac && e.ctrlKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  let key = e.key.toLowerCase();
  // Physical key for letters/digits/punctuation so Alt, Shift or the Korean
  // IME don't change it.
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else if (key === ' ') key = 'space';
  parts.push(key);
  const combo = parts.join('+');
  // Ctrl+Tab on Windows / Linux is "ctrl+tab", like the macOS Control key.
  return mac ? combo : combo.replace(/^mod\+(shift\+)?tab$/, 'ctrl+$1tab');
}

/** Whether a combo may be used as a command shortcut (needs a modifier, or a function key). */
export function isAssignable(combo: string): boolean {
  if (!combo) return false;
  const plus = combo.endsWith('++');
  const parts = (plus ? combo.slice(0, -2) : combo).split('+').filter(Boolean);
  const key = plus ? '+' : (parts.pop() ?? '');
  if (/^f\d{1,2}$/.test(key)) return true;
  // Plain or Shift-only keys are for typing.
  return parts.some((p) => p === 'mod' || p === 'ctrl' || p === 'alt');
}

const KEY_NAMES: Record<string, [string, string]> = {
  arrowup: ['↑', 'Up'],
  arrowdown: ['↓', 'Down'],
  arrowleft: ['←', 'Left'],
  arrowright: ['→', 'Right'],
  enter: ['↩', 'Enter'],
  escape: ['⎋', 'Esc'],
  backspace: ['⌫', 'Backspace'],
  delete: ['⌦', 'Delete'],
  tab: ['⇥', 'Tab'],
  space: ['Space', 'Space'],
  pageup: ['PgUp', 'PgUp'],
  pagedown: ['PgDn', 'PgDn'],
  home: ['Home', 'Home'],
  end: ['End', 'End'],
};

/** Display label: "⇧⌘M" on macOS, "Ctrl+Shift+M" elsewhere; '' for none. */
export function keyLabel(combo: string, mac = isMacPlatform): string {
  if (!combo) return '';
  const plus = combo.endsWith('++');
  const parts = (plus ? combo.slice(0, -2) : combo).split('+').filter(Boolean);
  const raw = plus ? '+' : parts.pop()!;
  const named = KEY_NAMES[raw];
  const key = named ? named[mac ? 0 : 1] : raw.toUpperCase();
  if (mac) {
    const sym: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' };
    return (
      ['ctrl', 'alt', 'shift', 'mod']
        .filter((m) => parts.includes(m))
        .map((m) => sym[m])
        .join('') + key
    );
  }
  const name: Record<string, string> = { mod: 'Ctrl', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt' };
  const mods = [...new Set(['mod', 'ctrl', 'shift', 'alt'].filter((m) => parts.includes(m)).map((m) => name[m]))];
  return [...mods, key].join('+');
}

/** Label of a command's current shortcut ('' when unbound). */
export function shortcut(id: string): string {
  return keyLabel(current[id] ?? '');
}

/** Menu commands only — sent to the native menu. */
export function menuBindings(keys: Record<string, string>): Record<string, string> {
  return Object.fromEntries(COMMANDS.filter((c) => c.menu).map((c) => [c.id, keys[c.id] ?? '']));
}

/** While the settings screen records a shortcut, commands must not run. */
export const keyCapture = { active: false };
