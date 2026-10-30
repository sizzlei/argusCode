// JavaScript support (mongosh scripts), loaded the first time a .js file is
// opened: syntax, mongosh completion / hover and a syntax-error linter.

import { Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { linter, Diagnostic } from '@codemirror/lint';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { mongoCompletionSource, mongoExtensions } from './mongotools';

// mongosh shell commands that are not JavaScript: "use shop", "show dbs", "it".
const SHELL_CMD = /^\s*(use\s+\S+|show\s+\w+|it|exit|quit)\s*;?\s*$/;

const syntaxLinter = linter(
  (view) => {
    const { state } = view;
    const out: Diagnostic[] = [];
    syntaxTree(state).iterate({
      enter(n) {
        if (!n.type.isError || out.length >= 50) return;
        const line = state.doc.lineAt(n.from);
        if (SHELL_CMD.test(line.text)) return;
        if (out.some((d) => state.doc.lineAt(d.from).number === line.number)) return;
        const from = Math.min(n.from, state.doc.length);
        const to = Math.min(Math.max(n.to, from + 1), line.to);
        out.push({ from, to: Math.max(to, from), severity: 'error', message: '구문 오류' });
      },
    });
    return out;
  },
  { delay: 500 },
);

export function jsExtension(): Extension {
  return [
    javascript(),
    javascriptLanguage.data.of({ autocomplete: mongoCompletionSource() }),
    mongoExtensions(),
    syntaxLinter,
  ];
}
