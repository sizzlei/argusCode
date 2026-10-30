// DDL model for the rule-based review (ddlrules.ts). Parses CREATE TABLE,
// ALTER TABLE, CREATE INDEX, COMMENT ON, DROP / TRUNCATE / RENAME for MySQL,
// PostgreSQL and Oracle on top of the SQL formatter's tokenizer, keeping
// source offsets so findings can be underlined. Tolerant: anything it does
// not understand is skipped, never thrown. No dependencies.

import { tokenize, type Tok, type FormatDialect } from './sqlformat.ts';

export type DdlDialect = 'mysql' | 'postgresql' | 'oracle';

export interface Span {
  from: number;
  to: number;
}

export interface Column {
  name: string;
  at: Span; // the column name
  span: Span; // whole definition
  type: string; // as written, e.g. "varchar(100)", "NUMBER(10,2)"
  base: string; // lower-case base type: varchar, bigint, number, timestamp …
  length?: number; // first type argument
  unsigned: boolean;
  nullable: boolean | null; // null = not specified
  hasDefault: boolean;
  defaultValue?: string;
  autoIncrement: boolean; // AUTO_INCREMENT, SERIAL, IDENTITY
  primaryKey: boolean; // inline PRIMARY KEY
  unique: boolean; // inline UNIQUE
  comment?: string;
  charset?: string;
  collate?: string;
  position?: 'first' | 'after';
  /** MySQL ON UPDATE … (e.g. CURRENT_TIMESTAMP). */
  onUpdate?: string;
}

export interface Index {
  name?: string;
  at: Span;
  kind: 'primary' | 'unique' | 'index' | 'fulltext' | 'spatial' | 'foreign' | 'check';
  columns: string[]; // lower-case names (expressions as written)
  def?: Span; // whole definition (CONSTRAINT … / KEY … (…)) inside CREATE / ALTER TABLE
}

export interface Table {
  kind: 'create';
  name: string;
  schema?: string;
  at: Span; // the table name
  span: Span; // whole statement
  columns: Column[];
  indexes: Index[];
  options: Record<string, string>; // lower-case keys: engine, charset, collate, comment, tablespace …
  comment?: string;
  temporary: boolean;
}

export type AlterAction =
  | { kind: 'addColumn'; column: Column }
  | { kind: 'modifyColumn'; column: Column; from?: string }
  | { kind: 'dropColumn'; name: string; at: Span }
  | { kind: 'renameColumn'; from: string; to: string; at: Span }
  | { kind: 'addIndex'; index: Index }
  | { kind: 'dropIndex'; name: string; at: Span }
  | { kind: 'rename'; to: string; at: Span }
  | { kind: 'option'; key: string; value: string; at: Span }
  | { kind: 'other'; text: string; at: Span };

export interface Alter {
  kind: 'alter';
  name: string;
  schema?: string;
  at: Span;
  span: Span;
  actions: AlterAction[];
}

export interface CreateIndex {
  kind: 'index';
  index: Index;
  table: string;
  span: Span;
  concurrently: boolean; // PostgreSQL
  online: boolean; // Oracle / MySQL ALGORITHM
}

export interface CommentOn {
  kind: 'comment';
  target: 'table' | 'column';
  table: string;
  column?: string;
  text: string;
  span: Span;
}

export interface Other {
  kind: 'drop' | 'truncate' | 'renameTable';
  object: string; // TABLE, INDEX, COLUMN, DATABASE …
  name: string;
  span: Span;
}

/** CREATE VIEW / SEQUENCE / TRIGGER / PROCEDURE / FUNCTION / PACKAGE / EVENT / SYNONYM … */
export interface ObjectDef {
  kind: 'object';
  object: string; // upper case: VIEW, MATERIALIZED VIEW, PACKAGE BODY …
  name: string;
  at: Span;
  span: Span;
  table?: string; // TRIGGER … ON table
}

export type Statement = Table | Alter | CreateIndex | CommentOn | Other | ObjectDef;

const unquote = (v: string) => (/^[`"[]/.test(v) ? v.slice(1, -1) : v);
const strValue = (t: Tok | undefined) => {
  if (!t) return '';
  let v = t.v;
  if (/^[NnEe]'/.test(v)) v = v.slice(1);
  return v.slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'");
};
const isName = (t?: Tok) => !!t && (t.t === 'word' || t.t === 'qid');

// Words that end a column's type and start its attributes.
const ATTR = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'KEY', 'AUTO_INCREMENT', 'COMMENT', 'COLLATE', 'CHARSET',
  'REFERENCES', 'CHECK', 'CONSTRAINT', 'GENERATED', 'AS', 'ON', 'VISIBLE', 'INVISIBLE', 'IDENTITY', 'ENCRYPT',
  'SRID', 'STORAGE', 'COLUMN_FORMAT', 'ENABLE', 'DISABLE', 'FIRST', 'AFTER', 'USING', 'SORT',
]); // prettier-ignore

/** Splits tokens into statements at top-level ';' (and Oracle '/' lines). */
function statements(toks: Tok[], src: string, oracle: boolean): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  let plsql = false;
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
    plsql = false;
  };
  for (const t of toks) {
    if (t.t === 'lc' || t.t === 'bc') continue;
    // A lone "/" on its own line ends an Oracle statement or PL/SQL block.
    if (t.t === 'op' && t.v === '/') {
      const ls = src.lastIndexOf('\n', t.s - 1) + 1;
      const le = src.indexOf('\n', t.e);
      if (!src.slice(ls, t.s).trim() && !src.slice(t.e, le < 0 ? src.length : le).trim()) {
        flush();
        continue;
      }
    }
    cur.push(t);
    // PL/SQL units contain ';' inside: keep them whole until "/".
    // Oracle PL/SQL units contain ';' inside: keep them whole until "/".
    // (MySQL ends them at ';' unless DELIMITER is changed; PostgreSQL bodies are $$-quoted.)
    if (oracle && cur.length <= 6 && cur[0].u === 'CREATE') {
      const head = cur.map((x) => x.u).join(' ');
      if (/^CREATE (OR REPLACE )?(EDITIONABLE |NONEDITIONABLE )?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\b/.test(head))
        plsql = true;
    }
    if (t.t === '(') depth++;
    else if (t.t === ')') depth = Math.max(0, depth - 1);
    else if (t.t === ';' && depth === 0 && !plsql) flush();
  }
  flush();
  return out;
}

/** Splits a token list at top-level commas. */
function splitCommas(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let d = 0;
  for (const t of toks) {
    if (t.t === '(') d++;
    if (t.t === ')') d--;
    if (t.t === ',' && d === 0) {
      out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Index of the ')' matching the '(' at `i`. */
function closing(toks: Tok[], i: number): number {
  let d = 0;
  for (let k = i; k < toks.length; k++) {
    if (toks[k].t === '(') d++;
    else if (toks[k].t === ')' && --d === 0) return k;
  }
  return toks.length - 1;
}

/** [schema.]name starting at i → { name, schema, next index } */
function qname(toks: Tok[], i: number): { name: string; schema?: string; at: Span; next: number } | null {
  if (!isName(toks[i])) return null;
  let name = unquote(toks[i].v);
  let schema: string | undefined;
  let at = { from: toks[i].s, to: toks[i].e };
  let k = i + 1;
  while (toks[k]?.t === '.' && isName(toks[k + 1])) {
    schema = schema ? schema + '.' + name : name;
    name = unquote(toks[k + 1].v);
    at = { from: toks[k + 1].s, to: toks[k + 1].e };
    k += 2;
  }
  return { name, schema, at, next: k };
}

const textOf = (src: string, toks: Tok[]) => (toks.length ? src.slice(toks[0].s, toks[toks.length - 1].e) : '');

function indexColumns(toks: Tok[], open: number, src: string): string[] {
  const close = closing(toks, open);
  return splitCommas(toks.slice(open + 1, close)).map((part) => {
    const words = part.filter((t) => !/^(ASC|DESC)$/.test(t.u));
    if (words.length === 1 && isName(words[0])) return unquote(words[0].v).toLowerCase();
    if (isName(words[0]) && words[1]?.t === '(') return unquote(words[0].v).toLowerCase(); // prefix length
    return textOf(src, words);
  });
}

function parseColumn(toks: Tok[], src: string): Column | null {
  if (!isName(toks[0])) return null;
  const c: Column = {
    name: unquote(toks[0].v),
    at: { from: toks[0].s, to: toks[0].e },
    span: { from: toks[0].s, to: toks[toks.length - 1].e },
    type: '',
    base: '',
    unsigned: false,
    nullable: null,
    hasDefault: false,
    autoIncrement: false,
    primaryKey: false,
    unique: false,
  };
  // type: words (and one parenthesised argument list) until an attribute keyword
  let i = 1;
  const typeToks: Tok[] = [];
  while (i < toks.length) {
    const t = toks[i];
    if (t.t === 'word' && ATTR.has(t.u) && typeToks.length) break;
    if (t.t === 'word' && t.u === 'CHARACTER' && typeToks.length && toks[i + 1]?.u === 'SET') break;
    if (t.t === '(') {
      const close = closing(toks, i);
      typeToks.push(...toks.slice(i, close + 1));
      const n = toks.slice(i + 1, close).find((x) => x.t === 'num');
      if (n && c.length == null) c.length = Number(n.v);
      i = close + 1;
      continue;
    }
    if (t.t !== 'word' && t.t !== 'qid') break;
    typeToks.push(t);
    i++;
  }
  c.type = textOf(src, typeToks);
  c.base = (typeToks[0]?.v ?? '').toLowerCase();
  const second = typeToks[1]?.u;
  if ((c.base === 'character' || c.base === 'char') && second === 'VARYING') c.base = 'varchar';
  else if (c.base === 'character') c.base = 'char';
  else if (c.base === 'double' && second === 'PRECISION') c.base = 'double';
  else if (c.base === 'national' && typeToks.some((t) => t.u === 'VARYING')) c.base = 'nvarchar';
  if (/^(small|big)?serial\d?$/.test(c.base)) c.autoIncrement = true;
  if (typeToks.some((t) => t.u === 'UNSIGNED')) c.unsigned = true;

  for (; i < toks.length; i++) {
    const t = toks[i];
    const u = t.u;
    const next = toks[i + 1];
    if (u === 'NOT' && next?.u === 'NULL') {
      c.nullable = false;
      i++;
    } else if (u === 'NULL') c.nullable = true;
    else if (u === 'DEFAULT') {
      c.hasDefault = true;
      // the value: one token, or a call/paren group
      const v = toks[i + 1];
      if (v) {
        let end = i + 1;
        if (toks[i + 2]?.t === '(') end = closing(toks, i + 2);
        else if (v.t === '(') end = closing(toks, i + 1);
        c.defaultValue = textOf(src, toks.slice(i + 1, end + 1));
        i = end;
      }
    } else if (u === 'AUTO_INCREMENT' || u === 'IDENTITY' || u === 'AUTOINCREMENT') c.autoIncrement = true;
    else if (u === 'GENERATED') {
      // GENERATED {ALWAYS | BY DEFAULT [ON NULL]} AS IDENTITY [(…)] — not a DEFAULT value
      const id = toks.findIndex((x, n) => n > i && x.u === 'IDENTITY');
      if (id > 0) {
        c.autoIncrement = true;
        i = toks[id + 1]?.t === '(' ? closing(toks, id + 1) : id;
      }
    } else if (u === 'PRIMARY' && next?.u === 'KEY') {
      c.primaryKey = true;
      i++;
    } else if (u === 'UNIQUE') c.unique = true;
    else if (u === 'COMMENT' && next?.t === 'str') {
      c.comment = strValue(next);
      i++;
    } else if ((u === 'CHARACTER' && next?.u === 'SET') || u === 'CHARSET') {
      const v = toks[u === 'CHARSET' ? i + 1 : i + 2];
      if (v) c.charset = unquote(v.v);
      i += u === 'CHARSET' ? 1 : 2;
    } else if (u === 'COLLATE' && next) {
      c.collate = unquote(next.v);
      i++;
    } else if (u === 'ON' && next?.u === 'UPDATE') {
      const v = toks[i + 2];
      let end = i + 2;
      if (toks[i + 3]?.t === '(') end = closing(toks, i + 3);
      c.onUpdate = v ? textOf(src, toks.slice(i + 2, end + 1)) : 'UPDATE';
      i = end;
    } else if (u === 'FIRST') c.position = 'first';
    else if (u === 'AFTER') {
      c.position = 'after';
      i++;
    }
  }
  return c;
}

/** CONSTRAINT / PRIMARY KEY / UNIQUE / INDEX / KEY / FOREIGN KEY element, or null for a column. */
function parseIndexDef(toks: Tok[], src: string): Index | null {
  let i = 0;
  let name: string | undefined;
  if (toks[0]?.u === 'CONSTRAINT') {
    if (isName(toks[1]) && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK)$/.test(toks[1].u)) {
      name = unquote(toks[1].v);
      i = 2;
    } else i = 1;
  }
  const u = toks[i]?.u;
  let kind: Index['kind'];
  if (u === 'PRIMARY') kind = 'primary';
  else if (u === 'UNIQUE') kind = 'unique';
  else if (u === 'INDEX' || u === 'KEY') kind = 'index';
  else if (u === 'FULLTEXT') kind = 'fulltext';
  else if (u === 'SPATIAL') kind = 'spatial';
  else if (u === 'FOREIGN') kind = 'foreign';
  else if (u === 'CHECK') kind = 'check';
  else return null; // a column
  let k = i + 1;
  while (toks[k] && toks[k].t !== '(') {
    if (isName(toks[k]) && !/^(KEY|INDEX|USING|BTREE|HASH)$/.test(toks[k].u) && !name) name = unquote(toks[k].v);
    k++;
  }
  const columns = toks[k] && kind !== 'check' ? indexColumns(toks, k, src) : [];
  const at = name
    ? (() => {
        const t = toks.find((x) => isName(x) && unquote(x.v) === name)!;
        return { from: t.s, to: t.e };
      })()
    : { from: toks[0].s, to: toks[Math.min(i, toks.length - 1)].e };
  return { name, at, kind, columns, def: span(toks) };
}

const span = (toks: Tok[]): Span => ({ from: toks[0].s, to: toks[toks.length - 1].e });

function parseCreateTable(st: Tok[], src: string): Table | null {
  // CREATE [GLOBAL|LOCAL] [TEMPORARY] TABLE [IF NOT EXISTS] name ( … ) options
  let i = 1;
  let temporary = false;
  while (st[i] && st[i].u !== 'TABLE') {
    if (/TEMP/.test(st[i].u)) temporary = true;
    i++;
  }
  i++;
  if (st[i]?.u === 'IF' && st[i + 1]?.u === 'NOT' && st[i + 2]?.u === 'EXISTS') i += 3;
  const qn = qname(st, i);
  if (!qn) return null;
  const t: Table = {
    kind: 'create',
    name: qn.name,
    schema: qn.schema,
    at: qn.at,
    span: span(st),
    columns: [],
    indexes: [],
    options: {},
    temporary,
  };
  let k = qn.next;
  if (st[k]?.t !== '(') return t; // CREATE TABLE … AS SELECT / LIKE
  const close = closing(st, k);
  for (const part of splitCommas(st.slice(k + 1, close))) {
    if (!part.length) continue;
    const idx = parseIndexDef(part, src);
    if (idx) t.indexes.push(idx);
    else if (part[0].u !== 'CHECK' && part[0].u !== 'CONSTRAINT' && part[0].u !== 'LIKE') {
      const col = parseColumn(part, src);
      if (col) t.columns.push(col);
    }
  }
  for (const c of t.columns) {
    if (c.primaryKey) t.indexes.push({ kind: 'primary', columns: [c.name.toLowerCase()], at: c.at });
    if (c.unique) t.indexes.push({ kind: 'unique', columns: [c.name.toLowerCase()], at: c.at });
  }
  t.options = tableOptions(st.slice(close + 1));
  if (t.options.comment != null) t.comment = t.options.comment;
  return t;
}

/** key[=]value table options (MySQL) plus TABLESPACE (Oracle / PostgreSQL). */
function tableOptions(toks: Tok[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'word') continue;
    if (t.u === 'PARTITION' || t.u === 'AS') break;
    let key = t.u.toLowerCase();
    let j = i + 1;
    if (t.u === 'DEFAULT') continue;
    if (t.u === 'CHARACTER' && toks[j]?.u === 'SET') {
      key = 'charset';
      j++;
    }
    if (key === 'character') continue;
    if (toks[j]?.t === 'op' && toks[j].v === '=') j++;
    const v = toks[j];
    if (!v || v.t === '(' || v.t === ',') continue;
    if (
      key === 'collate' ||
      key === 'charset' ||
      key === 'engine' ||
      key === 'comment' ||
      key === 'tablespace' ||
      key === 'row_format' ||
      key === 'auto_increment' ||
      key === 'key_block_size' ||
      key === 'compression'
    ) {
      // prettier-ignore
      o[key] = v.t === 'str' ? strValue(v) : unquote(v.v);
      i = j;
    }
  }
  return o;
}

function parseAlter(st: Tok[], src: string): Alter | null {
  // ALTER TABLE [ONLY] [IF EXISTS] name action, action …
  let i = 2;
  while (st[i] && /^(ONLY|IF|EXISTS)$/.test(st[i].u)) i++;
  const qn = qname(st, i);
  if (!qn) return null;
  const a: Alter = { kind: 'alter', name: qn.name, schema: qn.schema, at: qn.at, span: span(st), actions: [] };
  const body = st.slice(qn.next).filter((t) => t.t !== ';');
  // Oracle: ADD (col, col) / MODIFY (col, col)
  for (const part of splitCommas(body)) {
    if (!part.length) continue;
    const u0 = part[0].u;
    const u1 = part[1]?.u;
    const at = span(part);
    const rest = (n: number) => part.slice(n);
    const columnsIn = (p: Tok[]) => (p[0]?.t === '(' ? splitCommas(p.slice(1, closing(p, 0))) : [p]);
    if (u0 === 'ADD') {
      let p = rest(1);
      if (p[0]?.u === 'COLUMN') p = p.slice(1);
      if (p[0]?.u === 'IF') p = p.slice(3);
      const idx = parseIndexDef(p, src);
      if (idx) a.actions.push({ kind: 'addIndex', index: idx });
      else
        for (const cp of columnsIn(p)) {
          const col = parseColumn(cp, src);
          if (col) a.actions.push({ kind: 'addColumn', column: col });
        }
    } else if (u0 === 'MODIFY') {
      let p = rest(1);
      if (p[0]?.u === 'COLUMN') p = p.slice(1);
      for (const cp of columnsIn(p)) {
        const col = parseColumn(cp, src);
        if (col) a.actions.push({ kind: 'modifyColumn', column: col });
      }
    } else if (u0 === 'CHANGE') {
      let p = rest(1);
      if (p[0]?.u === 'COLUMN') p = p.slice(1);
      const col = parseColumn(p.slice(1), src);
      if (col) a.actions.push({ kind: 'modifyColumn', column: col, from: unquote(p[0]?.v ?? '') });
    } else if (u0 === 'ALTER' && (u1 === 'COLUMN' || isName(part[1]))) {
      // PostgreSQL: ALTER [COLUMN] c TYPE … / SET NOT NULL / SET DEFAULT …
      const p = u1 === 'COLUMN' ? rest(2) : rest(1);
      const typeAt = p.findIndex((t) => t.u === 'TYPE');
      if (typeAt > 0) {
        const col = parseColumn([p[0], ...p.slice(typeAt + 1)], src);
        if (col) a.actions.push({ kind: 'modifyColumn', column: col });
      } else a.actions.push({ kind: 'other', text: textOf(src, part), at });
    } else if (u0 === 'DROP') {
      const p = rest(1);
      if (
        p[0]?.u === 'INDEX' ||
        p[0]?.u === 'KEY' ||
        p[0]?.u === 'CONSTRAINT' ||
        (p[0]?.u === 'FOREIGN' && p[1]?.u === 'KEY')
      ) {
        const n = p[0].u === 'FOREIGN' ? p[2] : p[1]?.u === 'IF' ? p[3] : p[1];
        a.actions.push({ kind: 'dropIndex', name: unquote(n?.v ?? ''), at });
      } else if (p[0]?.u === 'PRIMARY') a.actions.push({ kind: 'dropIndex', name: 'PRIMARY', at });
      else {
        let q = p[0]?.u === 'COLUMN' ? p.slice(1) : p;
        if (q[0]?.u === 'IF') q = q.slice(2);
        if (q[0]?.t === '(') q = q.slice(1);
        if (isName(q[0])) a.actions.push({ kind: 'dropColumn', name: unquote(q[0].v), at });
      }
    } else if (u0 === 'RENAME') {
      if (u1 === 'COLUMN' && part[3]?.u === 'TO')
        a.actions.push({ kind: 'renameColumn', from: unquote(part[2].v), to: unquote(part[4]?.v ?? ''), at });
      else if (u1 === 'TO' || u1 === 'AS' || isName(part[1]))
        a.actions.push({ kind: 'rename', to: unquote(part[u1 === 'TO' || u1 === 'AS' ? 2 : 1]?.v ?? ''), at });
    } else {
      const opts = tableOptions(part);
      const keys = Object.keys(opts);
      if (keys.length) for (const k of keys) a.actions.push({ kind: 'option', key: k, value: opts[k], at });
      else if (/^(ALGORITHM|LOCK)$/.test(u0)) {
        const v = part.find((t, n) => n > 0 && t.t === 'word');
        a.actions.push({ kind: 'option', key: u0.toLowerCase(), value: (v?.v ?? '').toUpperCase(), at });
      } else a.actions.push({ kind: 'other', text: textOf(src, part), at });
    }
  }
  return a;
}

function parseCreateIndex(st: Tok[], src: string): CreateIndex | null {
  // CREATE [UNIQUE|FULLTEXT|SPATIAL|BITMAP] INDEX [CONCURRENTLY] [IF NOT EXISTS] name ON table [USING m] (cols) [ONLINE]
  let i = 1;
  let kind: Index['kind'] = 'index';
  if (st[i].u === 'UNIQUE') kind = 'unique';
  else if (st[i].u === 'FULLTEXT') kind = 'fulltext';
  else if (st[i].u === 'SPATIAL') kind = 'spatial';
  while (st[i] && st[i].u !== 'INDEX') i++;
  i++;
  let concurrently = false;
  if (st[i]?.u === 'CONCURRENTLY') {
    concurrently = true;
    i++;
  }
  if (st[i]?.u === 'IF') i += 3;
  let name: string | undefined;
  let at: Span = span(st);
  if (st[i]?.u !== 'ON') {
    const qn = qname(st, i);
    if (qn) {
      name = qn.name;
      at = qn.at;
      i = qn.next;
    }
  }
  if (st[i]?.u !== 'ON') return null;
  if (st[i + 1]?.u === 'ONLY') i++;
  const tn = qname(st, i + 1);
  if (!tn) return null;
  const open = st.findIndex((t, n) => n > tn.next - 1 && t.t === '(');
  const columns = open > 0 ? indexColumns(st, open, src) : [];
  const online =
    st.some((t) => t.u === 'ONLINE') ||
    st.some((t, n) => t.u === 'ALGORITHM' && /INPLACE|INSTANT/i.test(st[n + 2]?.v ?? st[n + 1]?.v ?? ''));
  return { kind: 'index', index: { name, at, kind, columns }, table: tn.name, span: span(st), concurrently, online };
}

function parseCommentOn(st: Tok[]): CommentOn | null {
  // COMMENT ON TABLE t IS '…' / COMMENT ON COLUMN t.c IS '…'
  const target = st[2]?.u;
  if (target !== 'TABLE' && target !== 'COLUMN') return null;
  const is = st.findIndex((t) => t.u === 'IS');
  if (is < 0) return null;
  const parts = st
    .slice(3, is)
    .filter(isName)
    .map((t) => unquote(t.v));
  const text = strValue(st[is + 1]);
  if (target === 'TABLE')
    return { kind: 'comment', target: 'table', table: parts[parts.length - 1] ?? '', text, span: span(st) };
  return {
    kind: 'comment',
    target: 'column',
    table: parts[parts.length - 2] ?? '',
    column: parts[parts.length - 1],
    text,
    span: span(st),
  };
}

const OBJECTS = [
  'MATERIALIZED VIEW',
  'PACKAGE BODY',
  'VIEW',
  'SEQUENCE',
  'TRIGGER',
  'PROCEDURE',
  'FUNCTION',
  'PACKAGE',
  'EVENT',
  'SYNONYM',
];

function parseCreateObject(st: Tok[]): ObjectDef | null {
  // CREATE [OR REPLACE] [EDITIONABLE] [FORCE] [PUBLIC] [ALGORITHM=…] [DEFINER=…] [SQL SECURITY …] <object> [IF NOT EXISTS] name
  for (let i = 1; i < Math.min(st.length, 24); i++) {
    if (st[i].t !== 'word') continue;
    const two = st[i].u + ' ' + (st[i + 1]?.u ?? '');
    const obj = OBJECTS.find((o) => o === two || o === st[i].u);
    if (!obj) continue;
    // DEFINER = user / SQL SECURITY: skip values that look like keywords
    if (st[i - 1]?.t === 'op' && st[i - 1].v === '=') continue;
    let k = i + obj.split(' ').length;
    if (st[k]?.u === 'IF') k += st[k + 1]?.u === 'NOT' ? 3 : 2;
    const qn = qname(st, k);
    if (!qn) return null;
    const o: ObjectDef = { kind: 'object', object: obj, name: qn.name, at: qn.at, span: span(st) };
    if (obj === 'TRIGGER') {
      const on = st.findIndex((t, n) => n > qn.next && t.u === 'ON');
      const tn = on > 0 ? qname(st, on + 1) : null;
      if (tn) o.table = tn.name;
    }
    return o;
  }
  return null;
} // prettier-ignore

/**
 * mysql client scripts: "DELIMITER $$ … END$$ … DELIMITER ;". Blanks the
 * DELIMITER lines and turns the custom delimiter into ';' (same length, so
 * offsets are unchanged).
 */
function blankDelimiters(src: string): string {
  let delim = ';';
  return src
    .split('\n')
    .map((line) => {
      const m = /^(\s*)DELIMITER\s+(\S+)\s*$/i.exec(line);
      if (m) {
        delim = m[2];
        return ' '.repeat(line.length);
      }
      if (delim !== ';' && line.trimEnd().endsWith(delim)) {
        const end = line.trimEnd().length;
        return line.slice(0, end - delim.length) + ';' + ' '.repeat(delim.length - 1) + line.slice(end);
      }
      return line;
    })
    .join('\n');
}

/** Parses every DDL statement in the text (other statements are ignored). */
export function parseDdl(src: string, dialect: DdlDialect): Statement[] {
  const fd: FormatDialect = dialect === 'oracle' ? 'plsql' : dialect;
  const out: Statement[] = [];
  if (dialect === 'mysql' && /^\s*DELIMITER\s/im.test(src)) src = blankDelimiters(src);
  for (const st of statements(tokenize(src, fd), src, dialect === 'oracle')) {
    const u = st.map((t) => t.u);
    try {
      if (u[0] === 'CREATE') {
        const head = u.slice(0, 6).join(' ');
        if (/^CREATE (OR REPLACE )?(GLOBAL |LOCAL |PRIVATE )?(TEMPORARY |TEMP |UNLOGGED )?TABLE\b/.test(head)) {
          const t = parseCreateTable(st, src);
          if (t) out.push(t);
        } else if (/^CREATE (UNIQUE |FULLTEXT |SPATIAL |BITMAP )?INDEX\b/.test(head)) {
          const ix = parseCreateIndex(st, src);
          if (ix) out.push(ix);
        } else {
          const o = parseCreateObject(st);
          if (o) out.push(o);
        }
      } else if (u[0] === 'ALTER' && u[1] === 'TABLE') {
        const a = parseAlter(st, src);
        if (a) out.push(a);
      } else if (u[0] === 'COMMENT' && u[1] === 'ON') {
        const c = parseCommentOn(st);
        if (c) out.push(c);
      } else if (u[0] === 'DROP' || u[0] === 'TRUNCATE') {
        let i = 1;
        const words: string[] = [];
        while (
          st[i] &&
          st[i].t === 'word' &&
          !/^(IF)$/.test(st[i].u) &&
          words.length < 2 &&
          /^(TABLE|INDEX|DATABASE|SCHEMA|VIEW|SEQUENCE|USER|TABLESPACE|TEMPORARY|MATERIALIZED|PROCEDURE|FUNCTION|TRIGGER|PACKAGE|EVENT)$/.test(
            st[i].u,
          )
        )
          words.push(st[i++].u);
        if (st[i]?.u === 'IF') i += 2;
        const qn = qname(st, i);
        out.push({
          kind: u[0] === 'TRUNCATE' ? 'truncate' : 'drop',
          object: words.join(' ') || (u[0] === 'TRUNCATE' ? 'TABLE' : ''),
          name: qn?.name ?? '',
          span: span(st),
        });
      } else if (u[0] === 'RENAME' && u[1] === 'TABLE') {
        const qn = qname(st, 2);
        out.push({ kind: 'renameTable', object: 'TABLE', name: qn?.name ?? '', span: span(st) });
      }
    } catch {
      /* unparseable statement: skip */
    }
  }
  return out;
}

/** True when the text contains statements the DDL review looks at. */
export const looksLikeDdl = (text: string) =>
  /\b(CREATE\s+(OR\s+REPLACE\s+)?((GLOBAL|LOCAL|TEMPORARY|TEMP|UNLOGGED|UNIQUE|FULLTEXT|SPATIAL|BITMAP)\s+)*(TABLE|INDEX)|ALTER\s+TABLE|COMMENT\s+ON|DROP\s+\w+|TRUNCATE\s+|RENAME\s+TABLE)\b/i.test(
    text,
  );
