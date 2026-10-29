// SQL helpers built on the folder's DDL schema:
//   * hover: table / column type and comment
//   * go to definition: F12 or Cmd/Ctrl+click → CREATE TABLE in its file
//   * select the statement under the cursor (⇧⌘A / Ctrl+Shift+A)
//   * turn a pasted list of values into an IN list

import { EditorSelection, EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, hoverTooltip, keymap } from '@codemirror/view';
import { isMac, SchemaColumn, SchemaTable } from './backend';
import { Tok, tokenize, toInList } from './sqlformat';

// ---- schema index -------------------------------------------------------------

let tables: SchemaTable[] = [];
const byName = new Map<string, SchemaTable[]>();

export function setSchemaIndex(t: SchemaTable[]) {
  tables = t;
  byName.clear();
  for (const x of t) {
    const k = x.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), x]);
  }
}

export type Navigate = (file: string, line: number, name: string) => void;
let navigate: Navigate = () => {};
export function setNavigator(fn: Navigate) {
  navigate = fn;
}

function findTable(name: string, schema?: string): SchemaTable | undefined {
  const list = byName.get(name.toLowerCase());
  if (!list) return undefined;
  if (schema) return list.find((t) => t.schema?.toLowerCase() === schema.toLowerCase()) ?? list[0];
  return list[0];
}

function findColumn(t: SchemaTable, name: string): SchemaColumn | undefined {
  const n = name.toLowerCase();
  return t.columns?.find((c) => c.name.toLowerCase() === n);
}

// ---- tokens & statements -----------------------------------------------------------

const unquote = (t: Tok) => (t.t === 'qid' ? t.v.slice(1, -1) : t.v);
const isIdent = (t: Tok | undefined) => !!t && (t.t === 'word' || t.t === 'qid');

/** Splits the document into statements (token ranges) at top-level ';'. */
function statements(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [[]];
  let d = 0;
  for (const t of toks) {
    if (t.t === '(') d++;
    else if (t.t === ')') d = Math.max(0, d - 1);
    out[out.length - 1].push(t);
    if (t.t === ';' && d === 0) out.push([]);
  }
  return out.filter((s) => s.some((t) => t.t !== 'lc' && t.t !== 'bc' && t.t !== ';'));
}

function statementAtPos(state: EditorState, pos: number): Tok[] | null {
  const toks = tokenize(state.doc.toString());
  const stmts = statements(toks);
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    const end = s[s.length - 1].e;
    const nextStart = stmts[i + 1]?.[0].s ?? Infinity;
    if (pos <= end || pos < nextStart) return s;
  }
  return stmts[stmts.length - 1] ?? null;
}

/** Selects the whole statement around the cursor (including its ';'). */
export function selectStatement(view: EditorView): boolean {
  const s = statementAtPos(view.state, view.state.selection.main.head);
  if (!s) return false;
  const code = s.filter((t) => t.t !== 'lc' && t.t !== 'bc');
  const from = (code[0] ?? s[0]).s;
  const to = s[s.length - 1].e;
  view.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: true });
  return true;
}

const NOT_ALIAS = new Set([
  'WHERE',
  'ON',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'CROSS',
  'GROUP',
  'ORDER',
  'LIMIT',
  'SET',
  'USING',
  'UNION',
  'HAVING',
  'VALUES',
  'SELECT',
  'FROM',
  'AND',
  'OR',
  'WINDOW',
  'FOR',
  'STRAIGHT_JOIN',
  'NATURAL',
  'FULL',
  'INTO',
  'LATERAL',
  'PARTITION',
  'USE',
  'FORCE',
  'IGNORE',
  'WITH',
  'RETURNING',
  'EXCEPT',
  'INTERSECT',
  'MINUS',
]);

/** alias / table name (lower-case) → table, for tables referenced in a statement. */
function aliasMap(toks: Tok[]): Map<string, SchemaTable> {
  const m = new Map<string, SchemaTable>();
  for (let i = 0; i < toks.length; i++) {
    if (!isIdent(toks[i])) continue;
    let schema: string | undefined;
    let k = i;
    if (toks[i + 1]?.t === '.' && isIdent(toks[i + 2])) {
      schema = unquote(toks[i]);
      k = i + 2;
    }
    const t = findTable(unquote(toks[k]), schema);
    if (!t) continue;
    m.set(t.name.toLowerCase(), t);
    let j = k + 1;
    if (toks[j]?.t === 'word' && toks[j].u === 'AS') j++;
    const a = toks[j];
    if (isIdent(a) && !(a.t === 'word' && NOT_ALIAS.has(a.u)) && toks[j + 1]?.t !== '(' && toks[j + 1]?.t !== '.') {
      m.set(unquote(a).toLowerCase(), t);
    }
    i = k;
  }
  return m;
}

interface Resolved {
  from: number;
  to: number;
  table: SchemaTable;
  column?: SchemaColumn;
}

/** Resolves the identifier at `pos` to a table or column of the schema. */
export function resolveAt(state: EditorState, pos: number): Resolved | null {
  if (!tables.length) return null;
  const stmt = statementAtPos(state, pos);
  if (!stmt) return null;
  const idx = stmt.findIndex((t) => isIdent(t) && t.s <= pos && pos <= t.e);
  if (idx < 0) return null;
  // Collect the dotted chain around the cursor: a.b.c
  let start = idx;
  while (start >= 2 && stmt[start - 1].t === '.' && isIdent(stmt[start - 2])) start -= 2;
  let end = idx;
  while (stmt[end + 1]?.t === '.' && isIdent(stmt[end + 2])) end += 2;
  const parts: Tok[] = [];
  for (let k = start; k <= end; k += 2) parts.push(stmt[k]);
  const at = (idx - start) / 2;
  const tok = stmt[idx];
  const name = unquote(tok);
  const aliases = aliasMap(stmt);

  const isLast = at === parts.length - 1;
  if (parts.length >= 2 && isLast) {
    const q = unquote(parts[at - 1]);
    const t = aliases.get(q.toLowerCase()) ?? findTable(q);
    const c = t && findColumn(t, name);
    if (t && c) return { from: tok.s, to: tok.e, table: t, column: c };
    const st = findTable(name, q); // schema.table
    if (st) return { from: tok.s, to: tok.e, table: st };
    return null;
  }
  if (parts.length >= 2 && !isLast) {
    // Cursor on a qualifier: alias, table or schema.
    const t = aliases.get(name.toLowerCase()) ?? findTable(name, at > 0 ? unquote(parts[at - 1]) : undefined);
    return t ? { from: tok.s, to: tok.e, table: t } : null;
  }
  // Single identifier: a table, an alias, or a column of a referenced table.
  const t = findTable(name) ?? aliases.get(name.toLowerCase());
  if (t) return { from: tok.s, to: tok.e, table: t };
  const seen = new Set<SchemaTable>(aliases.values());
  for (const rt of seen) {
    const c = findColumn(rt, name);
    if (c) return { from: tok.s, to: tok.e, table: rt, column: c };
  }
  return null;
}

// ---- go to definition --------------------------------------------------------------

function goTo(r: Resolved) {
  if (r.column) navigate(r.table.file, r.column.line || r.table.line || 1, r.column.name);
  else navigate(r.table.file, r.table.line || 1, r.table.name);
}

export function goToDefinition(view: EditorView): boolean {
  const r = resolveAt(view.state, view.state.selection.main.head);
  if (!r) return false;
  goTo(r);
  return true;
}

// ---- hover ---------------------------------------------------------------------------

const hover = hoverTooltip(
  (view, pos) => {
    const r = resolveAt(view.state, pos);
    if (!r) return null;
    return {
      pos: r.from,
      end: r.to,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'sql-hover';
        const head = document.createElement('div');
        head.className = 'sql-hover-head';
        const t = r.table;
        const full = (t.schema ? t.schema + '.' : '') + t.name;
        if (r.column) {
          head.append(strong(`${full}.${r.column.name}`), span(' ' + (r.column.type || ''), 'sql-hover-type'));
          dom.append(head);
          if (r.column.comment) dom.append(div(r.column.comment, 'sql-hover-comment'));
        } else {
          head.append(
            strong(full),
            span(` ${t.kind === 'view' ? 'view' : 'table'} · 컬럼 ${t.columns?.length ?? 0}개`, 'sql-hover-type'),
          );
          dom.append(head);
          if (t.comment) dom.append(div(t.comment, 'sql-hover-comment'));
        }
        dom.append(
          div(`${t.file}:${r.column?.line || t.line} — ${isMac ? '⌘' : 'Ctrl+'}클릭 또는 F12로 이동`, 'sql-hover-file'),
        );
        return { dom };
      },
    };
  },
  { hoverTime: 350 },
);

function strong(text: string) {
  const e = document.createElement('strong');
  e.textContent = text;
  return e;
}
function span(text: string, cls: string) {
  const e = document.createElement('span');
  e.className = cls;
  e.textContent = text;
  return e;
}
function div(text: string, cls: string) {
  const e = document.createElement('div');
  e.className = cls;
  e.textContent = text;
  return e;
}

// ---- IN list ---------------------------------------------------------------------------

export function convertToInList(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  const from = r.empty ? 0 : r.from;
  const to = r.empty ? state.doc.length : r.to;
  const out = toInList(state.sliceDoc(from, to));
  view.dispatch({ changes: { from, to, insert: out }, selection: EditorSelection.range(from, from + out.length) });
  return true;
}

// ---- extension -------------------------------------------------------------------------

export function sqlTools(): Extension {
  return [
    hover,
    Prec.high(
      keymap.of([
        { key: 'F12', run: goToDefinition },
        { key: 'Mod-Shift-a', run: selectStatement, preventDefault: true },
      ]),
    ),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (e.button !== 0 || !(isMac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const r = resolveAt(view.state, pos);
        if (!r) return false;
        e.preventDefault();
        goTo(r);
        return true;
      },
    }),
  ];
}
