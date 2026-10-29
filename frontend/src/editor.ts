import { Compartment, EditorState, Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  highlightWhitespace,
  highlightTrailingWhitespace,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldKeymap,
  indentUnit,
} from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap, search } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';
import { languageExtension, DialectId, LangId } from './languages';

/** Per-state compartments so language / indentation can be swapped live. */
export const langComp = new Compartment();
export const indentComp = new Compartment();
export const wrapComp = new Compartment();
export const wsComp = new Compartment();

export type Whitespace = 'none' | 'trailing' | 'all';

export function whitespaceExtension(w: Whitespace): Extension {
  if (w === 'all') return [highlightWhitespace(), highlightTrailingWhitespace()];
  if (w === 'trailing') return highlightTrailingWhitespace();
  return [];
}

const argusTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--bg-editor)', fontSize: 'var(--editor-font-size)' },
    '.cm-scroller': { fontFamily: 'var(--editor-font, var(--font-mono))', lineHeight: '1.55' },
    '.cm-trailingSpace': { backgroundColor: '#e5675f40' },
    '.cm-highlightSpace': {
      backgroundImage: 'radial-gradient(circle at 50% 55%, #5c637099 11%, transparent 5%)',
    },
    '.cm-highlightTab': { opacity: '0.45' },
    '.cm-gutters': { backgroundColor: 'var(--bg-editor)', borderRight: 'none', color: '#5c6370' },
    '.cm-activeLine': { backgroundColor: '#2a2d3366' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#c9ccd3' },
    '.cm-panels': { backgroundColor: 'var(--bg-side)', color: 'var(--fg)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-search input, .cm-search button': { fontSize: '12px' },
    '.cm-tooltip': { border: '1px solid var(--border)' },
  },
  { dark: true },
);

/** Korean UI strings for CodeMirror's built-in panels (search, go to line, lint, folding). */
const koreanPhrases = EditorState.phrases.of({
  Find: '찾기',
  Replace: '바꾸기',
  next: '다음',
  previous: '이전',
  all: '모두 선택',
  'match case': '대/소문자 구분',
  'by word': '단어 단위',
  regexp: '정규식',
  replace: '바꾸기',
  'replace all': '모두 바꾸기',
  close: '닫기',
  'current match': '현재 일치 항목',
  'on line': '줄',
  'replaced $ matches': '$개 항목을 바꿨습니다',
  'replaced match on line $': '$번째 줄의 항목을 바꿨습니다',
  'Go to line': '줄로 이동',
  go: '이동',
  'Selection deleted': '선택 영역 삭제됨',
  Completions: '자동완성',
  Diagnostics: '문제',
  'No diagnostics': '문제 없음',
  'Control character': '제어 문자',
  'Fold line': '접기',
  'Unfold line': '펼치기',
  'folded code': '접힌 코드',
  unfold: '펼치기',
  'Folded lines': '접힌 줄',
  'Unfolded lines': '펼친 줄',
  to: '~',
  '$ unchanged lines': '변경 없는 $줄',
  Accept: '적용',
  Reject: '취소',
  'Revert this chunk': '이 변경 되돌리기',
});

/** Shared, language-independent extensions. */
function base(onUpdate: Extension): Extension {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    oneDark,
    argusTheme,
    koreanPhrases,
    onUpdate,
  ];
}

export function indentExtension(size: number): Extension {
  return [indentUnit.of(' '.repeat(size)), EditorState.tabSize.of(size)];
}

export function createState(
  text: string,
  lang: LangId,
  opts: { dialect: DialectId; indent: number; wrap: boolean; whitespace: Whitespace },
  onUpdate: Extension,
  large = false,
): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      base(onUpdate),
      langComp.of(languageExtension(lang, opts.dialect, large)),
      indentComp.of(indentExtension(opts.indent)),
      wrapComp.of(opts.wrap ? EditorView.lineWrapping : []),
      wsComp.of(whitespaceExtension(opts.whitespace)),
    ],
  });
}

/** Read-only editor setup used by the diff viewer. */
export function viewerExtensions(lang: LangId, dialect: DialectId, large = false): Extension {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    drawSelection(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...searchKeymap]),
    EditorState.readOnly.of(true),
    oneDark,
    argusTheme,
    koreanPhrases,
    languageExtension(lang, dialect, large),
  ];
}
