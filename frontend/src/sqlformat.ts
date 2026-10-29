// River-style SQL formatter.
//
//   SELECT o.member_id,
//          COUNT(*)      AS cnt,
//          SUM(o.amount) AS total
//     FROM orders o
//     JOIN members m
//       ON m.id = o.member_id
//    WHERE o.created_at >= '2026-10-01'
//      AND m.grade      = 'VIP'
//    GROUP BY o.member_id
//    ORDER BY total DESC
//    LIMIT 100;
//
// * Clause keywords are right-aligned on a 6-character "river".
// * Lists use trailing commas; `AS` aliases and comparison operators are
//   aligned. Sub-queries get their own river at the column of their "(".
// * Keyword / identifier case is preserved exactly as written.
// * DML (SELECT / WITH / INSERT / REPLACE / UPDATE / DELETE) and CREATE TABLE
//   are reformatted; any other statement is left untouched.
// * Procedural code (procedures, functions, triggers, DELIMITER, BEGIN …
//   END blocks) is refused, because ';' inside bodies cannot be split safely.
//
// The module has no dependencies so it can be unit-tested with plain Node.

export type FormatDialect = 'mysql' | 'postgresql' | 'plsql' | 'standard';

export type FormatStyle = 'left' | 'river';

export interface FormatOptions {
  dialect?: FormatDialect;
  /**
   * left  (default): keywords at the left margin, SELECT items on their own
   *        indented lines, AND/OR indented under WHERE.
   * river: keywords right-aligned on a 6-character river.
   */
  style?: FormatStyle;
  /** Indent for items and AND/OR in the "left" style (default 2). */
  indent?: number;
  /** Indent for CREATE TABLE column lists (default 4). */
  tableIndent?: number;
}

export class SqlFormatError extends Error {}

// ---- tokens --------------------------------------------------------------------

type TT =
  | 'lc' // line comment
  | 'bc' // block comment
  | 'str'
  | 'qid' // quoted identifier
  | 'num'
  | 'word'
  | 'param'
  | 'op'
  | '('
  | ')'
  | ','
  | ';'
  | '.';

export interface Tok {
  t: TT;
  v: string;
  u: string; // upper-case value (words)
  s: number; // start offset
  e: number; // end offset
  unary?: boolean;
}

const OPS3 = ['<=>', '->>', '!~*'];
const OPS2 = ['<>', '!=', '<=', '>=', '||', '::', ':=', '->', '&&', '<<', '>>', '=>', '!~', '~*', '@>', '<@', '#>'];
const isWordStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

export function tokenize(src: string, dialect: FormatDialect = 'mysql'): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  const push = (t: TT, s: number, e: number) => {
    const v = src.slice(s, e);
    out.push({ t, v, u: t === 'word' ? v.toUpperCase() : v, s, e });
  };
  const readQuoted = (start: number, q: string, backslash: boolean): number => {
    let j = start + 1;
    while (j < n) {
      const c = src[j];
      if (backslash && c === '\\') {
        j += 2;
        continue;
      }
      if (c === q) {
        if (src[j + 1] === q) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return n; // unterminated: take the rest
  };
  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f') {
      i++;
      continue;
    }
    if (c2 === '--' || (c === '#' && dialect === 'mysql')) {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      push('lc', i, src[j - 1] === '\r' ? j - 1 : j);
      i = j;
      continue;
    }
    if (c2 === '/*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      push('bc', i, j);
      i = j;
      continue;
    }
    // String literal with optional prefix: N'..' E'..' B'..' X'..' _utf8mb4'..'
    if (c === "'") {
      const j = readQuoted(i, "'", dialect === 'mysql');
      push('str', i, j);
      i = j;
      continue;
    }
    if (/[NnEeBbXx]/.test(c) && src[i + 1] === "'") {
      const j = readQuoted(i + 1, "'", dialect === 'mysql' || c === 'E' || c === 'e');
      push('str', i, j);
      i = j;
      continue;
    }
    if (c === '"' && dialect !== 'mysql') {
      const j = readQuoted(i, '"', false);
      push('qid', i, j);
      i = j;
      continue;
    }
    if (c === '"') {
      const j = readQuoted(i, '"', true);
      push('str', i, j);
      i = j;
      continue;
    }
    if (c === '`') {
      const j = readQuoted(i, '`', false);
      push('qid', i, j);
      i = j;
      continue;
    }
    // PostgreSQL dollar quoting: $$...$$ or $tag$...$tag$
    if (c === '$' && dialect === 'postgresql') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = src.indexOf(tag, i + tag.length);
        const j = end < 0 ? n : end + tag.length;
        push('str', i, j);
        i = j;
        continue;
      }
      const p = /^\$\d+/.exec(src.slice(i, i + 12));
      if (p) {
        push('param', i, i + p[0].length);
        i += p[0].length;
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0x[0-9a-fA-F]+|0b[01]+|\d*\.?\d+(?:[eE][+-]?\d+)?|\d+\.)/.exec(src.slice(i, i + 64))!;
      let j = i + m[0].length;
      // Identifiers may start with digits in MySQL (e.g. 1st_table).
      if (dialect === 'mysql' && j < n && isWordChar(src[j]) && !/^0x|^0b/.test(m[0])) {
        while (j < n && isWordChar(src[j])) j++;
        push('word', i, j);
      } else push('num', i, j);
      i = j;
      continue;
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(src[j])) j++;
      push('word', i, j);
      i = j;
      continue;
    }
    if (c === '@' || (c === ':' && isWordStart(src[i + 1] ?? '') && src[i - 1] !== ':')) {
      let j = i + 1;
      if (src[j] === '@') j++;
      while (j < n && (isWordChar(src[j]) || src[j] === '.')) j++;
      if (j > i + 1) {
        push('param', i, j);
        i = j;
        continue;
      }
    }
    if (c === '?') {
      push('param', i, i + 1);
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',' || c === ';' || c === '.') {
      push(c as TT, i, i + 1);
      i++;
      continue;
    }
    const three = src.slice(i, i + 3);
    if (OPS3.includes(three)) {
      push('op', i, i + 3);
      i += 3;
      continue;
    }
    if (OPS2.includes(c2)) {
      push('op', i, i + 2);
      i += 2;
      continue;
    }
    push('op', i, i + 1);
    i++;
  }
  markUnary(out);
  return out;
}

const UNARY_AFTER = new Set([
  'SELECT',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'ON',
  'WHEN',
  'THEN',
  'ELSE',
  'RETURN',
  'BY',
  'HAVING',
  'SET',
  'VALUES',
  'IN',
  'IS',
  'LIKE',
  'BETWEEN',
  'CASE',
  'LIMIT',
  'OFFSET',
  'INTERVAL',
  'AS',
]);

function markUnary(toks: Tok[]) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'op' || (t.v !== '-' && t.v !== '+' && t.v !== '~' && t.v !== '!')) continue;
    const p = prevCode(toks, i);
    if (!p || p.t === 'op' || p.t === '(' || p.t === ',' || (p.t === 'word' && UNARY_AFTER.has(p.u))) t.unary = true;
  }
}

function prevCode(toks: Tok[], i: number): Tok | null {
  for (let j = i - 1; j >= 0; j--) if (toks[j].t !== 'lc' && toks[j].t !== 'bc') return toks[j];
  return null;
}

// ---- helpers -------------------------------------------------------------------------

/** Display width: Hangul / CJK / full-width characters count as 2 columns. */
export function dw(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

const sp = (n: number) => ' '.repeat(Math.max(0, n));
const padTo = (s: string, w: number) => s + sp(w - dw(s));
const isComment = (t: Tok) => t.t === 'lc' || t.t === 'bc';

function matchParen(toks: Tok[], i: number): number {
  let d = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].t === '(') d++;
    else if (toks[j].t === ')' && --d === 0) return j;
  }
  return toks.length - 1;
}

function matchEnd(toks: Tok[], i: number): number {
  let d = 0;
  let p = 0;
  for (let j = i; j < toks.length; j++) {
    const t = toks[j];
    if (t.t === '(') p++;
    else if (t.t === ')') p--;
    else if (t.t === 'word' && p === 0) {
      if (t.u === 'CASE') d++;
      else if (t.u === 'END' && --d === 0) return j;
    }
  }
  return toks.length - 1;
}

function firstCode(toks: Tok[]): Tok | undefined {
  return toks.find((t) => !isComment(t));
}

/** Splits at depth-0 commas. Leading line comments of an item move to the
 *  previous item so "a, -- note" stays on the same line. */
interface Item {
  toks: Tok[];
  trail: Tok[]; // comments printed after the item's comma
}

function splitItems(toks: Tok[]): Item[] {
  const raw: Tok[][] = [[]];
  let d = 0;
  for (const t of toks) {
    if (t.t === '(') d++;
    if (t.t === ')') d--;
    if (t.t === ',' && d === 0) raw.push([]);
    else raw[raw.length - 1].push(t);
  }
  const items: Item[] = raw.map((r) => ({ toks: r, trail: [] }));
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // Leading comments that originally sat on the previous line → previous item.
    if (i > 0) {
      while (it.toks.length && it.toks[0].t === 'lc') items[i - 1].trail.push(it.toks.shift()!);
    }
    // Trailing line comments stay after the comma.
    while (it.toks.length && it.toks[it.toks.length - 1].t === 'lc') it.trail.unshift(it.toks.pop()!);
  }
  return items.filter((it, i) => it.toks.length || it.trail.length || i === 0);
}

// ---- spacing ---------------------------------------------------------------------------

const SPACE_BEFORE_PAREN = new Set([
  'AS',
  'IN',
  'ON',
  'AND',
  'OR',
  'NOT',
  'EXISTS',
  'FROM',
  'JOIN',
  'USING',
  'OVER',
  'WHEN',
  'THEN',
  'ELSE',
  'SELECT',
  'WHERE',
  'INTO',
  'TABLE',
  'ANY',
  'ALL',
  'SOME',
  'BY',
  'UNION',
  'IS',
  'LIKE',
  'BETWEEN',
  'RETURNING',
  'WITH',
  'RECURSIVE',
  'DISTINCT',
  'CASE',
  'SET',
  'KEY',
  'INDEX',
  'PRIMARY',
  'UNIQUE',
  'REFERENCES',
  'CHECK',
  'CONSTRAINT',
  'LATERAL',
  'HAVING',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
  'UPDATE',
  'LIMIT',
  'RETURN',
  'END',
  'PARTITION',
  'FOREIGN',
  'DEFAULT',
  'COMMENT',
  'ENGINE',
  'CHARSET',
  'COLLATE',
  'MATERIALIZED',
]);

interface Ctx {
  /** Put a space between an identifier and "(" (INSERT INTO t (a, b)). */
  identParenSpace?: boolean;
  /** Render CASE inline (used while measuring). */
  inlineCase?: boolean;
}

function needSpace(prev: Tok | null, cur: Tok, ctx: Ctx): boolean {
  if (!prev) return false;
  if (cur.t === ',' || cur.t === ';' || cur.t === ')' || cur.t === '.') return false;
  if (prev.t === '.' || prev.t === '(') return false;
  if (prev.unary) return false;
  if (cur.v === '::' || prev.v === '::') return false;
  if (prev.v === '[' || cur.v === ']') return false;
  if (cur.v === '[' && (prev.t === 'word' || prev.t === 'qid' || prev.t === ')' || prev.v === ']')) return false;
  if (cur.t === '(') {
    if (prev.t === 'word') return SPACE_BEFORE_PAREN.has(prev.u) || !!ctx.identParenSpace;
    if (prev.t === 'qid') return !!ctx.identParenSpace;
    return prev.t !== 'param';
  }
  return true;
}

// ---- formatter ---------------------------------------------------------------------------

const RIVER = 6;
const LIST_INLINE_MAX = 80;

interface Clause {
  u: string; // normalised keyword, e.g. "LEFT JOIN"
  first: string; // first keyword word as written
  kw: string; // keyword words as written, single-spaced
  body: Tok[];
}

const CLAUSES: string[][] = [
  ['WITH', 'RECURSIVE'],
  ['WITH'],
  ['SELECT'],
  ['FROM'],
  ['WHERE'],
  ['GROUP', 'BY'],
  ['HAVING'],
  ['WINDOW'],
  ['QUALIFY'],
  ['ORDER', 'BY'],
  ['LIMIT'],
  ['OFFSET'],
  ['FETCH'],
  ['FOR', 'UPDATE'],
  ['FOR', 'SHARE'],
  ['FOR', 'NO', 'KEY', 'UPDATE'],
  ['LOCK', 'IN', 'SHARE', 'MODE'],
  ['UNION', 'ALL'],
  ['UNION', 'DISTINCT'],
  ['UNION'],
  ['INTERSECT', 'ALL'],
  ['INTERSECT'],
  ['EXCEPT', 'ALL'],
  ['EXCEPT'],
  ['MINUS'],
  ['JOIN'],
  ['INNER', 'JOIN'],
  ['CROSS', 'JOIN'],
  ['STRAIGHT_JOIN'],
  ['LEFT', 'JOIN'],
  ['LEFT', 'OUTER', 'JOIN'],
  ['RIGHT', 'JOIN'],
  ['RIGHT', 'OUTER', 'JOIN'],
  ['FULL', 'JOIN'],
  ['FULL', 'OUTER', 'JOIN'],
  ['NATURAL', 'JOIN'],
  ['NATURAL', 'LEFT', 'JOIN'],
  ['NATURAL', 'RIGHT', 'JOIN'],
  ['NATURAL', 'LEFT', 'OUTER', 'JOIN'],
  ['CROSS', 'APPLY'],
  ['OUTER', 'APPLY'],
  ['ON', 'DUPLICATE', 'KEY', 'UPDATE'],
  ['ON', 'CONFLICT'],
  ['ON'],
  ['USING'],
  ['INSERT', 'INTO'],
  ['INSERT', 'IGNORE', 'INTO'],
  ['INSERT'],
  ['REPLACE', 'INTO'],
  ['REPLACE'],
  ['VALUES'],
  ['VALUE'],
  ['UPDATE'],
  ['SET'],
  ['DELETE', 'FROM'],
  ['DELETE'],
  ['RETURNING'],
];
// Longest sequences first.
CLAUSES.sort((a, b) => b.length - a.length);

const JOINS = new Set(CLAUSES.filter((c) => c.includes('JOIN') || c.includes('APPLY')).map((c) => c.join(' ')));
const SELECT_MODIFIERS = new Set([
  'DISTINCT',
  'ALL',
  'DISTINCTROW',
  'SQL_CALC_FOUND_ROWS',
  'SQL_NO_CACHE',
  'SQL_CACHE',
  'HIGH_PRIORITY',
  'SQL_SMALL_RESULT',
  'SQL_BIG_RESULT',
  'SQL_BUFFER_RESULT',
  'STRAIGHT_JOIN',
]);
const COMPARE = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '<=>']);

export class SqlFormatter {
  private dialect: FormatDialect;
  private indent: number;

  private style: FormatStyle;
  private tableIndent: number;

  constructor(o: FormatOptions = {}) {
    this.dialect = o.dialect ?? 'mysql';
    this.style = o.style ?? 'left';
    this.indent = o.indent ?? 2;
    this.tableIndent = o.tableIndent ?? 4;
  }

  format(src: string): string {
    const toks = tokenize(src, this.dialect);
    if (isProcedural(toks)) {
      throw new SqlFormatError(
        '프로시저·함수·트리거·DELIMITER·BEGIN 블록이 포함되어 있어 자동 정렬하지 않았습니다. 쿼리 부분만 선택해서 정렬해 주세요.',
      );
    }
    // Split into statements.
    const stmts: { toks: Tok[]; semi: boolean }[] = [];
    let cur: Tok[] = [];
    let d = 0;
    for (const t of toks) {
      if (t.t === '(') d++;
      if (t.t === ')') d = Math.max(0, d - 1);
      if (t.t === ';' && d === 0) {
        stmts.push({ toks: cur, semi: true });
        cur = [];
        d = 0;
      } else cur.push(t);
    }
    if (cur.length) stmts.push({ toks: cur, semi: false });

    const parts: string[] = [];
    for (const st of stmts) {
      if (!st.toks.length) continue;
      const text = this.statement(src, st.toks) + (st.semi ? ';' : '');
      parts.push(text);
    }
    return parts.join('\n\n');
  }

  private statement(src: string, toks: Tok[]): string {
    const lines: string[] = [];
    let i = 0;
    // Header comments on their own lines.
    while (i < toks.length && isComment(toks[i])) lines.push(toks[i++].v);
    const body = toks.slice(i);
    if (!body.length) return lines.join('\n');
    const f = body[0].u;
    let out: string[] | null = null;
    try {
      if (['SELECT', 'WITH', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE'].includes(f)) {
        out = this.block(body, 0);
      } else if (['EXPLAIN', 'DESC', 'DESCRIBE'].includes(f)) {
        const k = body.findIndex((t) => ['SELECT', 'WITH', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE'].includes(t.u));
        if (k > 0) out = [this.inline(body.slice(0, k), 0), ...this.block(body.slice(k), 0)];
      } else if (f === 'CREATE') {
        out = this.createTable(src, body);
      }
    } catch (e) {
      if (e instanceof SqlFormatError) throw e;
      out = null; // unexpected structure: leave as written
    }
    if (!out) out = [src.slice(body[0].s, body[body.length - 1].e)];
    return [...lines, ...out].map((l) => l.replace(/[ \t]+$/, '')).join('\n');
  }

  // ---- clauses ---------------------------------------------------------------------

  private splitClauses(toks: Tok[]): Clause[] | null {
    const clauses: Clause[] = [];
    let d = 0;
    let caseD = 0;
    let start = -1;
    let cur: Clause | null = null;
    const firstU = () => clauses[0]?.u ?? '';
    let seenDup = false;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t === '(') d++;
      else if (t.t === ')') d--;
      else if (t.t === 'word' && d === 0) {
        if (t.u === 'CASE') caseD++;
        else if (t.u === 'END' && caseD > 0) caseD--;
      }
      if (d !== 0 || caseD !== 0 || t.t !== 'word') {
        if (cur) cur.body.push(t);
        else if (start < 0) return null;
        continue;
      }
      const m = this.matchClause(toks, i, clauses, cur, firstU(), seenDup);
      if (m) {
        if (m.join(' ') === 'ON DUPLICATE KEY UPDATE') seenDup = true;
        const words = toks.slice(i, i + m.length);
        cur = {
          u: m.join(' '),
          first: words[0].v,
          kw: words.map((w) => w.v).join(' '),
          body: [],
        };
        clauses.push(cur);
        i += m.length - 1;
        start = i;
        if (cur.u === 'SELECT') {
          // Absorb modifiers such as DISTINCT into the keyword.
          while (toks[i + 1] && toks[i + 1].t === 'word' && SELECT_MODIFIERS.has(toks[i + 1].u)) {
            cur.kw += ' ' + toks[++i].v;
          }
        }
        continue;
      }
      if (cur) cur.body.push(t);
      else return null;
    }
    return clauses;
  }

  private matchClause(
    toks: Tok[],
    i: number,
    clauses: Clause[],
    cur: Clause | null,
    first: string,
    seenDup: boolean,
  ): string[] | null {
    const prev = prevCode(toks, i);
    for (const c of CLAUSES) {
      let ok = true;
      for (let k = 0; k < c.length; k++) {
        const t = toks[i + k];
        if (!t || t.t !== 'word' || t.u !== c[k]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const u = c.join(' ');
      const atStart = clauses.length === 0;
      switch (u) {
        case 'WITH':
        case 'WITH RECURSIVE':
          if (!atStart) continue;
          break;
        case 'UPDATE':
        case 'DELETE':
        case 'DELETE FROM':
        case 'INSERT':
        case 'INSERT INTO':
        case 'INSERT IGNORE INTO':
        case 'REPLACE':
        case 'REPLACE INTO':
          if (!atStart && !(cur && (cur.u === 'WITH' || cur.u === 'WITH RECURSIVE'))) continue;
          break;
        case 'ON':
        case 'USING':
          if (!cur || !JOINS.has(cur.u)) continue;
          break;
        case 'SET':
          if (!/^(UPDATE|INSERT|REPLACE)/.test(first) && !clauses.some((x) => x.u === 'UPDATE')) continue;
          break;
        case 'VALUES':
        case 'VALUE':
          if (seenDup || !clauses.some((x) => /^(INSERT|REPLACE)/.test(x.u))) continue;
          break;
        case 'FROM':
          if (prev?.u === 'DISTINCT') continue; // IS DISTINCT FROM
          break;
        case 'SELECT':
          break;
        default:
          if (atStart) return null; // must start with a statement keyword
      }
      return c;
    }
    return null;
  }

  /** Formats a query block; returns absolute lines (first line indented to base). */
  block(toks: Tok[], base: number): string[] {
    if (this.style === 'left') return this.leftBlock(toks, base);
    const clauses = this.splitClauses(toks);
    if (!clauses || !clauses.length) return [sp(base) + this.inline(toks, base)];
    const lines: string[] = [];
    for (const c of clauses) {
      const fw = dw(c.first);
      const col0 = base + Math.max(0, RIVER - fw);
      const head = sp(col0) + c.kw;
      const bodyToks = c.body;
      const code = bodyToks.filter((t) => !isComment(t));
      if (!code.length) {
        // e.g. "UNION ALL", "DELETE", or a clause followed only by comments
        lines.push(head + (bodyToks.length ? ' ' + bodyToks.map((t) => t.v).join(' ') : ''));
        continue;
      }
      const col = col0 + dw(c.kw) + 1;
      let body: string[];
      switch (c.u) {
        case 'SELECT':
        case 'RETURNING':
          body = this.list(bodyToks, col, { alignAs: true, always: true });
          break;
        case 'SET':
        case 'ON DUPLICATE KEY UPDATE':
          body = this.list(bodyToks, col, { alignEq: true, always: true });
          break;
        case 'WITH':
        case 'WITH RECURSIVE':
        case 'VALUES':
        case 'VALUE':
          body = this.list(bodyToks, col, { always: true });
          break;
        case 'FROM':
        case 'GROUP BY':
        case 'ORDER BY':
        case 'WINDOW':
          body = this.list(bodyToks, col, {});
          break;
        case 'WHERE':
        case 'HAVING':
        case 'ON':
        case 'QUALIFY':
          body = this.conditions(bodyToks, col, (op) => base + Math.max(0, RIVER - dw(op.v)), true);
          break;
        case 'INSERT':
        case 'INSERT INTO':
        case 'INSERT IGNORE INTO':
        case 'REPLACE':
        case 'REPLACE INTO':
          body = this.render(bodyToks, col, { identParenSpace: true });
          break;
        default:
          body = this.render(bodyToks, col, {});
      }
      lines.push(head + ' ' + body[0], ...body.slice(1));
    }
    return lines;
  }

  // ---- lists ---------------------------------------------------------------------------

  private list(toks: Tok[], col: number, o: { alignAs?: boolean; alignEq?: boolean; always?: boolean }): string[] {
    const items = splitItems(toks);
    // Leading comments before the first item (e.g. optimizer hints).
    const rendered = items.map((it) => this.render(it.toks, col, {}));
    const single = rendered.every((r) => r.length === 1) && items.every((it) => !it.trail.some((t) => t.t === 'lc'));
    if (!o.always || items.length === 1) {
      const joined = rendered.map((r, i) => r[0] + (i < items.length - 1 ? ',' : '')).join(' ');
      if (single && col + dw(joined) <= LIST_INLINE_MAX) {
        const trail = items.flatMap((it) => it.trail).map((t) => t.v);
        return [joined + (trail.length ? ' ' + trail.join(' ') : '')];
      }
    }

    // Alignment of "expr AS alias" or "lhs = rhs".
    const split: ([string, string] | null)[] = items.map((it, i) => {
      if (rendered[i].length !== 1) return null;
      if (o.alignAs) return this.splitAlias(it.toks, col);
      if (o.alignEq) return this.splitAt(it.toks, col, (t) => t.v === '=');
      return null;
    });
    const widths = split.filter((s): s is [string, string] => !!s && dw(s[0]) <= 50).map((s) => dw(s[0]));
    const maxW = widths.length > 1 ? Math.max(...widths) : -1;

    const out: string[] = [];
    items.forEach((it, i) => {
      let r = rendered[i];
      const s = split[i];
      if (s && maxW >= 0 && dw(s[0]) <= 50) r = [padTo(s[0], maxW) + ' ' + s[1]];
      r = [...r];
      const last = r.length - 1;
      if (i < items.length - 1) r[last] += ',';
      if (it.trail.length) r[last] += ' ' + it.trail.map((t) => t.v).join(' ');
      if (i === 0) out.push(...r);
      else out.push(sp(col) + r[0], ...r.slice(1));
    });
    return out;
  }

  /** "expr AS alias" → [expr, "AS alias"] when the alias is explicit. */
  private splitAlias(toks: Tok[], col: number): [string, string] | null {
    const code = toks.filter((t) => !isComment(t));
    const n = code.length;
    if (n < 3) return null;
    const as = code[n - 2];
    const alias = code[n - 1];
    if (as.t !== 'word' || as.u !== 'AS' || !['word', 'qid', 'str'].includes(alias.t)) return null;
    const k = toks.indexOf(as);
    const left = this.render(toks.slice(0, k), col, {});
    if (left.length !== 1) return null;
    return [left[0], this.inline(toks.slice(k), 0)];
  }

  /** Splits a single-line item at the first depth-0 token matching pred. */
  private splitAt(toks: Tok[], col: number, pred: (t: Tok) => boolean): [string, string] | null {
    let d = 0;
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.t === '(') d++;
      else if (t.t === ')') d--;
      else if (d === 0 && pred(t) && k > 0) {
        const left = this.render(toks.slice(0, k), col, {});
        const right = this.render(toks.slice(k), col, {});
        if (left.length !== 1 || right.length !== 1) return null;
        return [left[0], right[0]];
      }
    }
    return null;
  }

  // ---- conditions (WHERE / HAVING / ON) ------------------------------------------------

  /**
   * "left" style:
   *   SELECT
   *     a,
   *     b AS c
   *   FROM t
   *   JOIN u
   *     ON u.id = t.id
   *   WHERE x = 1
   *     AND y = 2
   */
  private leftBlock(toks: Tok[], base: number): string[] {
    const clauses = this.splitClauses(toks);
    if (!clauses || !clauses.length) return [sp(base) + this.inline(toks, base)];
    const ind = this.indent;
    const lines: string[] = [];
    for (const c of clauses) {
      const col0 = c.u === 'ON' || c.u === 'USING' ? base + ind : base;
      const head = sp(col0) + c.kw;
      const bodyToks = c.body;
      const code = bodyToks.filter((t) => !isComment(t));
      if (!code.length) {
        lines.push(head + (bodyToks.length ? ' ' + bodyToks.map((t) => t.v).join(' ') : ''));
        continue;
      }
      const col = col0 + dw(c.kw) + 1;
      const below = (body: string[]) => {
        // Keyword on its own line, items indented below it. Leading
        // comments (e.g. optimizer hints) stay on the keyword line.
        lines.push(head);
        lines.push(sp(base + ind) + body[0], ...body.slice(1));
      };
      switch (c.u) {
        case 'SELECT':
        case 'RETURNING':
          below(this.list(bodyToks, base + ind, { alignAs: true, always: true }));
          continue;
        case 'SET':
        case 'ON DUPLICATE KEY UPDATE':
          below(this.list(bodyToks, base + ind, { alignEq: true, always: true }));
          continue;
        case 'VALUES':
        case 'VALUE': {
          const items = splitItems(bodyToks);
          if (items.length > 1) {
            below(this.list(bodyToks, base + ind, { always: true }));
            continue;
          }
          break;
        }
        case 'WHERE':
        case 'HAVING':
        case 'ON':
        case 'QUALIFY': {
          const body = this.conditions(bodyToks, col, () => col0 + ind, false);
          lines.push(head + ' ' + body[0], ...body.slice(1));
          continue;
        }
      }
      let body: string[];
      switch (c.u) {
        case 'WITH':
        case 'WITH RECURSIVE':
          body = this.list(bodyToks, col, { always: true });
          break;
        case 'FROM':
        case 'GROUP BY':
        case 'ORDER BY':
        case 'WINDOW':
          body = this.list(bodyToks, col, {});
          break;
        case 'INSERT':
        case 'INSERT INTO':
        case 'INSERT IGNORE INTO':
        case 'REPLACE':
        case 'REPLACE INTO':
          body = this.render(bodyToks, col, { identParenSpace: true });
          break;
        default:
          body = this.render(bodyToks, col, {});
      }
      lines.push(head + ' ' + body[0], ...body.slice(1));
    }
    return lines;
  }

  private conditions(toks: Tok[], col: number, opColFor: (op: Tok) => number, align: boolean): string[] {
    const conds: { op: Tok | null; toks: Tok[] }[] = [{ op: null, toks: [] }];
    let d = 0;
    let caseD = 0;
    let between = false;
    for (const t of toks) {
      if (t.t === '(') d++;
      else if (t.t === ')') d--;
      else if (t.t === 'word' && d === 0) {
        if (t.u === 'CASE') caseD++;
        else if (t.u === 'END' && caseD > 0) caseD--;
        else if (caseD === 0) {
          if (t.u === 'BETWEEN') between = true;
          else if ((t.u === 'AND' || t.u === 'OR') && !(t.u === 'AND' && between)) {
            conds.push({ op: t, toks: [] });
            continue;
          } else if (t.u === 'AND' && between) between = false;
        }
      }
      conds[conds.length - 1].toks.push(t);
    }
    // Comments that end the previous line belong to the previous condition.
    for (let i = 1; i < conds.length; i++) {
      while (conds[i].toks.length && conds[i].toks[0].t === 'lc') conds[i - 1].toks.push(conds[i].toks.shift()!);
    }

    const opCol = opColFor;
    const colOf = (c: { op: Tok | null }) => (c.op ? opCol(c.op) + dw(c.op.v) + 1 : col);

    // Align comparison operators across single-line conditions.
    const parts = conds.map((c) => {
      const trailing: Tok[] = [];
      const ts = [...c.toks];
      while (ts.length && ts[ts.length - 1].t === 'lc') trailing.unshift(ts.pop()!);
      const s = this.splitAt(ts, colOf(c), (t) => t.t === 'op' && COMPARE.has(t.v));
      return { s, ts, trailing };
    });
    // Right-align the operators so the values start in the same column.
    const opW = (p: (typeof parts)[number]) => dw(p.s![1].split(' ')[0]);
    const ok = align ? parts.filter((p) => p.s && dw(p.s[0]) <= 40) : [];
    const maxW = ok.length > 1 ? Math.max(...ok.map((p) => dw(p.s![0]) + opW(p))) : -1;

    const out: string[] = [];
    conds.forEach((c, i) => {
      const p = parts[i];
      const ccol = colOf(c);
      let r: string[];
      if (p.s && maxW >= 0 && dw(p.s[0]) <= 40) r = [padTo(p.s[0], maxW - opW(p)) + ' ' + p.s[1]];
      else r = this.render(p.ts, ccol, {});
      r = [...r];
      if (p.trailing.length) r[r.length - 1] += ' ' + p.trailing.map((t) => t.v).join(' ');
      if (i === 0) out.push(...r);
      else out.push(sp(opCol(c.op!)) + c.op!.v + ' ' + r[0], ...r.slice(1));
    });
    return out;
  }

  // ---- expressions ---------------------------------------------------------------------

  /** Single-line rendering (sub-queries are still expanded if present). */
  inline(toks: Tok[], col: number): string {
    return this.render(toks, col, { inlineCase: true }).join(' ');
  }

  /**
   * Renders tokens starting at column `col`. The first returned line has no
   * indentation (the caller has already written up to `col`); following lines
   * are absolute.
   */
  render(toks: Tok[], col: number, ctx: Ctx): string[] {
    const lines = [''];
    let prev: Tok | null = null;
    const width = () => (lines.length === 1 ? col + dw(lines[0]) : dw(lines[lines.length - 1]));
    const write = (s: string) => {
      lines[lines.length - 1] += s;
    };
    const lineHasContent = () => (lines.length === 1 ? lines[0].length > 0 : lines[lines.length - 1].trim().length > 0);
    let breakNext = false;

    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (breakNext) {
        lines.push(sp(col));
        prev = null;
        breakNext = false;
      }
      if (t.t === 'lc') {
        if (lineHasContent()) write(' ');
        write(t.v);
        if (i < toks.length - 1) breakNext = true;
        continue;
      }
      if (t.t === '(') {
        const j = matchParen(toks, i);
        const inner = toks.slice(i + 1, j);
        const f = firstCode(inner);
        if (f && (f.u === 'SELECT' || f.u === 'WITH')) {
          if (needSpace(prev, t, ctx)) write(' ');
          write('(');
          const at = width();
          const sub = this.block(inner, at);
          write(sub[0].slice(at));
          lines.push(...sub.slice(1));
          write(')');
          prev = toks[j];
          i = j;
          continue;
        }
      }
      if (t.t === 'word' && t.u === 'CASE' && !ctx.inlineCase) {
        const j = matchEnd(toks, i);
        const caseToks = toks.slice(i, j + 1);
        if (needSpace(prev, t, ctx)) write(' ');
        const at = width();
        const flat = this.render(caseToks, at, { ...ctx, inlineCase: true });
        if (flat.length === 1 && dw(flat[0]) <= 60 && !caseToks.some((x) => x.t === 'lc')) {
          write(flat[0]);
        } else {
          const cl = this.caseBlock(caseToks, at, ctx);
          write(cl[0]);
          lines.push(...cl.slice(1));
        }
        prev = toks[j];
        i = j;
        continue;
      }
      if (needSpace(prev, t, ctx)) write(' ');
      write(t.v);
      prev = t;
    }
    return lines;
  }

  /** Multi-line CASE: WHEN/ELSE aligned, END right-aligned under CASE. */
  private caseBlock(toks: Tok[], at: number, ctx: Ctx): string[] {
    // toks = CASE ... END
    const sections: Tok[][] = [[]];
    let d = 0;
    let caseD = 0;
    const head: Tok[] = [];
    let inHead = true;
    for (let i = 1; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.t === '(') d++;
      else if (t.t === ')') d--;
      else if (t.t === 'word' && d === 0) {
        if (t.u === 'CASE') caseD++;
        else if (t.u === 'END' && caseD > 0) caseD--;
        else if (caseD === 0 && (t.u === 'WHEN' || t.u === 'ELSE')) {
          if (inHead) inHead = false;
          else sections.push([]);
        }
      }
      if (inHead) head.push(t);
      else sections[sections.length - 1].push(t);
    }
    const caseKw = toks[0].v;
    const endKw = toks[toks.length - 1].v;
    const secCol = at + dw(caseKw) + 1;
    const out: string[] = [];
    let first = caseKw;
    if (head.length) {
      first += ' ' + this.render(head, at + dw(caseKw) + 1, ctx).join(' ');
      out.push(first);
      for (const s of sections) {
        const r = this.render(s, secCol, ctx);
        out.push(sp(secCol) + r[0], ...r.slice(1));
      }
    } else {
      sections.forEach((s, k) => {
        const r = this.render(s, secCol, ctx);
        if (k === 0) out.push(caseKw + ' ' + r[0], ...r.slice(1));
        else out.push(sp(secCol) + r[0], ...r.slice(1));
      });
    }
    out.push(sp(at + Math.max(0, dw(caseKw) - dw(endKw))) + endKw);
    return out;
  }

  // ---- CREATE TABLE ----------------------------------------------------------------------

  private createTable(src: string, toks: Tok[]): string[] | null {
    const ti = toks.findIndex((t) => t.u === 'TABLE');
    if (ti < 0 || toks.slice(0, ti).some((t) => t.t !== 'word' && !isComment(t))) return null;
    const pi = toks.findIndex((t, k) => k > ti && t.t === '(');
    if (pi < 0) return null;
    // "CREATE TABLE x AS SELECT" or "LIKE" → leave alone.
    if (toks.slice(ti, pi).some((t) => t.u === 'AS' || t.u === 'LIKE' || t.u === 'SELECT')) return null;
    const pe = matchParen(toks, pi);
    const items = splitItems(toks.slice(pi + 1, pe));
    const ind = sp(this.tableIndent);
    const CONSTRAINT = new Set([
      'CONSTRAINT',
      'PRIMARY',
      'KEY',
      'INDEX',
      'UNIQUE',
      'FOREIGN',
      'CHECK',
      'FULLTEXT',
      'SPATIAL',
      'PERIOD',
      'EXCLUDE',
      'LIKE',
    ]);
    const TYPE_MODS = new Set(['UNSIGNED', 'SIGNED', 'ZEROFILL', 'PRECISION', 'VARYING']);
    type Row = { name: string; type: string; rest: string; raw?: string; trail: string };
    const rows: Row[] = items.map((it) => {
      const trail = it.trail.map((t) => t.v).join(' ');
      const code = it.toks;
      if (!code.length) return { name: '', type: '', rest: '', raw: '', trail };
      const f = code[0];
      if (isComment(f) || (f.t === 'word' && CONSTRAINT.has(f.u))) {
        return {
          name: '',
          type: '',
          rest: '',
          raw: this.render(code, this.tableIndent, { identParenSpace: true, inlineCase: true }).join(' '),
          trail,
        };
      }
      let k = 1;
      let type = '';
      if (code[k]) {
        type = code[k].v;
        k++;
        if (code[k]?.t === '(') {
          const e = matchParen(code, k);
          type += this.inline(code.slice(k, e + 1), 0);
          k = e + 1;
        }
        while (code[k]?.t === 'word' && TYPE_MODS.has(code[k].u)) type += ' ' + code[k++].v;
      }
      return { name: f.v, type, rest: this.inline(code.slice(k), 0), trail };
    });
    const cols = rows.filter((r) => r.raw === undefined);
    const nameW = Math.min(40, Math.max(0, ...cols.map((r) => dw(r.name))));
    const typeW = Math.min(30, Math.max(0, ...cols.map((r) => dw(r.type))));
    const out = [this.inline(toks.slice(0, pi), 0) + ' ('];
    rows.forEach((r, i) => {
      let line =
        r.raw !== undefined ? r.raw : [padTo(r.name, nameW), r.rest ? padTo(r.type, typeW) : r.type, r.rest].join(' ');
      line = line.replace(/\s+$/, '');
      if (i < rows.length - 1) line += ',';
      if (r.trail) line += ' ' + r.trail;
      out.push(ind + line);
    });
    const after = toks.slice(pe + 1);
    // Table options are kept exactly as written (ENGINE=InnoDB …).
    out.push(
      ')' + (after.length ? ' ' + src.slice(after[0].s, after[after.length - 1].e).replace(/\s*\n\s*/g, ' ') : ''),
    );
    return out;
  }
}

/** True when the text contains procedural code that must not be split on ';'. */
function isProcedural(toks: Tok[]): boolean {
  let stmtStart = true;
  let sawCreate = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (isComment(t)) continue;
    if (t.t === ';') {
      stmtStart = true;
      sawCreate = false;
      continue;
    }
    if (t.t === 'word') {
      if (t.u === 'DELIMITER') return true;
      if (
        stmtStart &&
        (t.u === 'DECLARE' ||
          (t.u === 'BEGIN' && !['TRANSACTION', 'WORK'].includes(toks[i + 1]?.u ?? '') && toks[i + 1]?.t !== ';'))
      )
        return true;
      if (stmtStart && (t.u === 'CREATE' || t.u === 'ALTER')) sawCreate = true;
      if (sawCreate && ['PROCEDURE', 'FUNCTION', 'TRIGGER', 'PACKAGE', 'EVENT'].includes(t.u)) return true;
    }
    stmtStart = false;
  }
  return false;
}

/** Convenience wrapper. */
export function formatSql(src: string, o: FormatOptions = {}): string {
  return new SqlFormatter(o).format(src);
}

/**
 * Converts a list of values (one per line, or separated by commas/tabs) into
 * an SQL IN list: ('a', 'b') — numbers stay unquoted, duplicates are dropped.
 */
export function toInList(text: string): string {
  const vals = text
    .split(/[\r\n,\t]+/)
    .map((v) =>
      v
        .trim()
        .replace(/^\(|\)$/g, '')
        .trim(),
    )
    .map((v) => v.replace(/^(['"`])(.*)\1$/, '$2'))
    .filter((v) => v.length > 0);
  const uniq = [...new Set(vals)];
  if (!uniq.length) return text;
  const numeric = uniq.every((v) => /^-?\d+(\.\d+)?$/.test(v));
  const items = uniq.map((v) => (numeric ? v : `'${v.replace(/'/g, "''")}'`));
  // Wrap long lists at ~100 columns.
  const lines: string[] = [];
  let cur = '';
  for (const it of items) {
    const piece = cur ? cur + ', ' + it : it;
    if (cur && piece.length > 100) {
      lines.push(cur + ',');
      cur = it;
    } else cur = piece;
  }
  lines.push(cur);
  return '(' + lines.join('\n ') + ')';
}
