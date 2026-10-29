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

const argusTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--bg-editor)', fontSize: 'var(--editor-font-size)' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
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
    onUpdate,
  ];
}

export function indentExtension(size: number): Extension {
  return [indentUnit.of(' '.repeat(size)), EditorState.tabSize.of(size)];
}

export function createState(
  text: string,
  lang: LangId,
  opts: { dialect: DialectId; indent: number; wrap: boolean },
  onUpdate: Extension,
): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      base(onUpdate),
      langComp.of(languageExtension(lang, opts.dialect)),
      indentComp.of(indentExtension(opts.indent)),
      wrapComp.of(opts.wrap ? EditorView.lineWrapping : []),
    ],
  });
}
