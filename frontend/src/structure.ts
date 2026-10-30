// Document structure helpers: outline items for the sidebar and the
// JSON/YAML path under the cursor. Everything is read from syntax trees
// CodeMirror already maintains (no extra parsing for MD/JSON/YAML).

import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { LangId } from './languages';
import { tokenize, Tok } from './sqlformat';

export interface OutlineItem {
  label: string;
  detail?: string;
  level: number; // 0-based nesting
  from: number;
}

const MAX_ITEMS = 2000;

function tree(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length, 300) ?? syntaxTree(state);
}

export function outline(state: EditorState, lang: LangId): OutlineItem[] {
  switch (lang) {
    case 'markdown':
      return markdownOutline(state);
    case 'json':
      return jsonOutline(state);
    case 'yaml':
      return yamlOutline(state);
    case 'sql':
      return sqlOutline(state);
    case 'javascript':
      return jsOutline(state);
    case 'shell':
      return shellOutline(state);
    default:
      return [];
  }
}

// ---- JavaScript (mongosh scripts): declarations and db / rs / sh calls -----------------

/** Text of the comment line(s) right above `from`, used as the description. */
function commentAbove(state: EditorState, from: number, marker: RegExp): string | undefined {
  const line = state.doc.lineAt(from);
  if (line.number < 2) return undefined;
  const prev = state.doc.line(line.number - 1).text.trim();
  const m = marker.exec(prev);
  return m ? m[1].trim() || undefined : undefined;
}

function jsOutline(state: EditorState): OutlineItem[] {
  const out: OutlineItem[] = [];
  const top = tree(state).topNode;
  const text = (n: SyntaxNode) => state.sliceDoc(n.from, n.to);
  const note = (n: SyntaxNode) => commentAbove(state, n.from, /^(?:\/\/+|\/\*+|\*)\s?(.*?)\s*(?:\*\/)?$/);
  const push = (label: string, n: SyntaxNode, level = 0, detail?: string) => {
    if (label && out.length < MAX_ITEMS) out.push({ label, detail: detail ?? note(n), level, from: n.from });
  };
  for (let c = top.firstChild; c; c = c.nextSibling) {
    switch (c.name) {
      case 'FunctionDeclaration': {
        const id = c.getChild('VariableDefinition');
        push((id ? text(id) : 'function') + '()', c);
        break;
      }
      case 'ClassDeclaration': {
        const id = c.getChild('VariableDefinition');
        push('class ' + (id ? text(id) : ''), c);
        const body = c.getChild('ClassBody');
        for (let m = body?.firstChild; m; m = m.nextSibling)
          if (m.name === 'MethodDeclaration') {
            const pd = m.getChild('PropertyDefinition');
            if (pd) push(text(pd) + '()', m, 1);
          }
        break;
      }
      case 'VariableDeclaration':
        for (let v = c.firstChild; v; v = v.nextSibling) if (v.name === 'VariableDefinition') push(text(v), c);
        break;
      case 'ExpressionStatement': {
        // db.orders.createIndex(…) → "db.orders.createIndex"
        const src = text(c);
        const m =
          /^(?:await\s+)?((?:db|rs|sh)\b(?:\s*\.\s*[\w$]+|\s*\.\s*getCollection\(\s*['"][^'"]*['"]\s*\)|\s*\[\s*['"][^'"]*['"]\s*\])*)/.exec(
            src,
          );
        const line = state.doc.lineAt(c.from);
        if (m) push(m[1].replace(/\s+/g, ''), c);
        else if (/^\s*use\s+\S+/.test(line.text) && !out.some((o) => o.from === line.from))
          out.push({ label: line.text.trim().replace(/;$/, ''), level: 0, from: line.from });
        break;
      }
      default: {
        // mongosh commands parsed as errors / identifiers: "use shop"
        const line = state.doc.lineAt(c.from).text.trim();
        if (/^use\s+\S+/.test(line) && !out.some((o) => o.from === state.doc.lineAt(c.from).from))
          out.push({ label: line.replace(/;$/, ''), level: 0, from: state.doc.lineAt(c.from).from });
      }
    }
  }
  return out;
}

// ---- Shell: functions ----------------------------------------------------------------

function shellOutline(state: EditorState): OutlineItem[] {
  const out: OutlineItem[] = [];
  const re = /^\s*(?:function\s+([\w.:-]+)\s*(?:\(\s*\))?|([\w.:-]+)\s*\(\s*\))\s*(?:\{|\(|$)/;
  for (let i = 1; i <= state.doc.lines && out.length < MAX_ITEMS; i++) {
    const line = state.doc.line(i);
    const m = re.exec(line.text);
    if (!m) continue;
    out.push({
      label: (m[1] ?? m[2]) + '()',
      detail: commentAbove(state, line.from, /^#+\s?(.*)$/),
      level: 0,
      from: line.from,
    });
  }
  return out;
}

// ---- Markdown: headings -------------------------------------------------------------

function markdownOutline(state: EditorState): OutlineItem[] {
  const out: OutlineItem[] = [];
  tree(state).iterate({
    enter(n) {
      const m = /^(?:ATXHeading|SetextHeading)(\d)$/.exec(n.name);
      if (!m) return;
      const text = state
        .sliceDoc(n.from, n.to)
        .split('\n')[0]
        .replace(/^#+\s*/, '')
        .replace(/\s*#+\s*$/, '')
        .trim();
      if (text && out.length < MAX_ITEMS) out.push({ label: text, level: +m[1] - 1, from: n.from });
      return false;
    },
  });
  // Normalise levels so the smallest heading level starts at 0.
  const min = Math.min(...out.map((i) => i.level));
  for (const i of out) i.level -= min;
  return out;
}

// ---- JSON / YAML: keys ------------------------------------------------------------------

const MAX_DEPTH = 5;

function unq(s: string) {
  return s.replace(/^["']|["']$/g, '');
}

function jsonOutline(state: EditorState): OutlineItem[] {
  const out: OutlineItem[] = [];
  let depth = -1;
  tree(state).iterate({
    enter(n) {
      if (n.name === 'Object' || n.name === 'Array') depth++;
      if (n.name === 'Property' && depth < MAX_DEPTH && out.length < MAX_ITEMS) {
        const key = n.node.getChild('PropertyName');
        if (key)
          out.push({
            label: unq(state.sliceDoc(key.from, key.to)),
            detail: valueKind(n.node, state),
            level: depth,
            from: n.from,
          });
      }
    },
    leave(n) {
      if (n.name === 'Object' || n.name === 'Array') depth--;
    },
  });
  return out;
}

function yamlOutline(state: EditorState): OutlineItem[] {
  const out: OutlineItem[] = [];
  let depth = -1;
  tree(state).iterate({
    enter(n) {
      if (n.name === 'BlockMapping' || n.name === 'FlowMapping') depth++;
      if (n.name === 'Pair' && depth < MAX_DEPTH && out.length < MAX_ITEMS) {
        const key = n.node.getChild('Key');
        if (key)
          out.push({
            label: unq(state.sliceDoc(key.from, key.to)),
            detail: valueKind(n.node, state),
            level: depth,
            from: n.from,
          });
      }
    },
    leave(n) {
      if (n.name === 'BlockMapping' || n.name === 'FlowMapping') depth--;
    },
  });
  return out;
}

function valueKind(n: SyntaxNode, state: EditorState): string | undefined {
  const v = n.lastChild;
  if (!v) return undefined;
  switch (v.name) {
    case 'Object':
    case 'BlockMapping':
    case 'FlowMapping':
      return '{…}';
    case 'Array':
    case 'BlockSequence':
    case 'FlowSequence':
      return '[…]';
    default: {
      const text = state.sliceDoc(v.from, Math.min(v.to, v.from + 40)).replace(/\s+/g, ' ');
      return v.name === ':' ? undefined : text + (v.to - v.from > 40 ? '…' : '');
    }
  }
}

/** JSONPath-style location of the cursor, e.g. $.replicas[0].host */
export function pathAt(state: EditorState, lang: LangId, pos: number): string | null {
  if (lang !== 'json' && lang !== 'yaml') return null;
  // Use the tree as parsed so far (never block the cursor on parsing).
  let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  const parts: string[] = [];
  for (; n; n = n.parent) {
    if (n.name === 'Property' || n.name === 'Pair') {
      const key = n.getChild(n.name === 'Property' ? 'PropertyName' : 'Key');
      if (key) {
        const k = unq(state.sliceDoc(key.from, key.to));
        parts.unshift(/^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : `[${JSON.stringify(k)}]`);
      }
    } else if (n.parent && ['Array', 'BlockSequence', 'FlowSequence'].includes(n.parent.name)) {
      // Index of this element among its siblings.
      const p = n.parent;
      const isItem = (c: SyntaxNode) => !['[', ']', ',', '-'].includes(c.name) && !c.type.isError;
      let i = 0;
      for (let c = p.firstChild; c && c.from < n.from; c = c.nextSibling) if (isItem(c)) i++;
      if (isItem(n)) parts.unshift(`[${i}]`);
    }
  }
  return parts.length ? '$' + parts.join('') : '$';
}

// ---- SQL: statements ----------------------------------------------------------------

function sqlOutline(state: EditorState): OutlineItem[] {
  const text = state.doc.toString();
  const toks = tokenize(text);
  const out: OutlineItem[] = [];
  let stmt: Tok[] = [];
  let comment = '';
  let d = 0;
  const flush = () => {
    const code = stmt.filter((t) => t.t !== 'lc' && t.t !== 'bc');
    if (code.length && out.length < MAX_ITEMS)
      out.push({ label: describe(code), detail: comment || undefined, level: 0, from: code[0].s });
    stmt = [];
    comment = '';
  };
  for (const t of toks) {
    if (t.t === '(') d++;
    if (t.t === ')') d = Math.max(0, d - 1);
    if ((t.t === 'lc' || t.t === 'bc') && !stmt.some((x) => x.t !== 'lc' && x.t !== 'bc')) {
      // Comment right before a statement: use it as the description.
      comment = t.v
        .replace(/^--\s?|^#\s?|^\/\*+\s*|\s*\*+\/$/g, '')
        .trim()
        .split('\n')[0];
      continue;
    }
    stmt.push(t);
    if (t.t === ';' && d === 0) flush();
  }
  flush();
  return out;
}

function describe(code: Tok[]): string {
  const w = code.map((t) => (t.t === 'word' ? t.u : t.v));
  // [schema.]name starting at token i
  const name = (i: number) => {
    const isId = (t?: Tok) => !!t && (t.t === 'word' || t.t === 'qid');
    if (!isId(code[i])) return '';
    let s = code[i].v;
    let k = i;
    while (code[k + 1]?.t === '.' && isId(code[k + 2])) {
      s += '.' + code[k + 2].v;
      k += 2;
    }
    return s;
  };
  const after = (kw: string) => {
    const i = w.indexOf(kw);
    return i >= 0 ? name(i + 1) : '';
  };
  const skip = (from: number, words: string[]) => {
    let i = from;
    while (i < w.length && words.includes(w[i])) i++;
    return i;
  };
  switch (w[0]) {
    case 'CREATE':
    case 'ALTER':
    case 'DROP':
    case 'TRUNCATE': {
      let i = skip(1, ['OR', 'REPLACE', 'TEMPORARY', 'TEMP', 'GLOBAL', 'LOCAL', 'UNIQUE', 'MATERIALIZED', 'ONLINE']);
      const kind = w[i] ?? '';
      i = skip(i + 1, ['IF', 'NOT', 'EXISTS']);
      return `${w[0]} ${kind} ${name(i)}`.trim();
    }
    case 'INSERT':
    case 'REPLACE':
      return `${w[0]} ${after('INTO')}`;
    case 'UPDATE':
      return `UPDATE ${name(1)}`;
    case 'DELETE':
      return `DELETE ${after('FROM')}`;
    case 'SELECT':
    case 'WITH': {
      const t = after('FROM');
      return t ? `${w[0]} … FROM ${t}` : w[0];
    }
    default:
      return code
        .slice(0, 4)
        .map((t) => t.v)
        .join(' ');
  }
}
