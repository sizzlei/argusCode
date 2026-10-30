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
  HighlightStyle,
  bracketMatching,
  foldKeymap,
  indentUnit,
} from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap, search } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { nextDiagnostic, previousDiagnostic } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';
import { tags as t } from '@lezer/highlight';
import { languageExtension, DialectId, LangId } from './languages';

/** Per-state compartments so language / indentation can be swapped live. */
export const langComp = new Compartment();
export const indentComp = new Compartment();
export const wrapComp = new Compartment();
export const wsComp = new Compartment();
export const themeComp = new Compartment();

export type ThemeId = 'dark' | 'light';

export type Whitespace = 'none' | 'trailing' | 'all';

export function whitespaceExtension(w: Whitespace): Extension {
  if (w === 'all') return [highlightWhitespace(), highlightTrailingWhitespace()];
  if (w === 'trailing') return highlightTrailingWhitespace();
  return [];
}

const argusTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg-editor)', fontSize: 'var(--editor-font-size)' },
  '.cm-scroller': { fontFamily: 'var(--editor-font, var(--font-mono))', lineHeight: '1.55' },
  '.cm-trailingSpace': { backgroundColor: '#e5675f40' },
  '.cm-highlightSpace': {
    backgroundImage: 'radial-gradient(circle at 50% 55%, #8b8f9899 11%, transparent 5%)',
  },
  '.cm-highlightTab': { opacity: '0.45' },
  '.cm-gutters': { backgroundColor: 'var(--bg-editor)', borderRight: 'none', color: 'var(--gutter-fg)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-panels': { backgroundColor: 'var(--bg-side)', color: 'var(--fg)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-search input, .cm-search button': { fontSize: '12px' },
  '.cm-tooltip': { border: '1px solid var(--border)' },
});

// Light: One Light–like colours on the app's white editor background.
const lightTheme = EditorView.theme(
  {
    '&': { color: '#383a42' },
    '.cm-content': { caretColor: '#1f6fd1' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#1f6fd1' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: '#cfe0f7' },
    '.cm-selectionMatch': { backgroundColor: '#e3ecd9' },
    '.cm-searchMatch': { backgroundColor: '#fde9a8', outline: '1px solid #e6c65a' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#f8d26a' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: '#dfe6ee', outline: '1px solid #b9c4d2' },
    '.cm-foldPlaceholder': { backgroundColor: '#eef0f3', border: '1px solid var(--border)', color: '#6b717b' },
    '.cm-tooltip': { backgroundColor: '#ffffff', color: 'var(--fg)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: '#dbe7f8', color: '#14171c' },
  },
  { dark: false },
);

const lightHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: '#a626a4' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#50a14f' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#986801' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#a0a1a7', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: '#4078f2' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.name)], color: '#c18401' },
  { tag: [t.propertyName, t.attributeName], color: '#e45649' },
  { tag: [t.definition(t.variableName), t.special(t.variableName)], color: '#0184bc' },
  { tag: [t.operator, t.punctuation, t.separator], color: '#4b5059' },
  { tag: [t.meta, t.processingInstruction], color: '#4078f2' },
  { tag: t.heading, color: '#e45649', fontWeight: 'bold' },
  { tag: [t.link, t.url], color: '#4078f2', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: '#e45649' },
]);

/** Editor colours of the app theme (swapped live through themeComp). */
export function themeExtension(theme: ThemeId): Extension {
  return theme === 'light' ? [lightTheme, syntaxHighlighting(lightHighlight)] : oneDark;
}

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
      // F8 / Shift+F8: next / previous problem. (The bottom lint panel's Mod-Shift-m
      // is replaced by the DDL review side panel.)
      { key: 'F8', run: nextDiagnostic, shift: previousDiagnostic },
      indentWithTab,
    ]),
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
  opts: { dialect: DialectId; indent: number; wrap: boolean; whitespace: Whitespace; theme: ThemeId },
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
      themeComp.of(themeExtension(opts.theme)),
    ],
  });
}

/** Read-only editor setup used by the diff viewer. */
export function viewerExtensions(lang: LangId, dialect: DialectId, large = false, theme: ThemeId = 'dark'): Extension {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    drawSelection(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...searchKeymap]),
    EditorState.readOnly.of(true),
    themeExtension(theme),
    argusTheme,
    koreanPhrases,
    languageExtension(lang, dialect, large),
  ];
}
