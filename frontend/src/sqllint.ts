// Light SQL syntax check. Only flags what is wrong in every dialect (or a
// clear accident), so valid dialect-specific SQL is never marked:
//
//   errors    unclosed string / quoted name / comment, unbalanced parentheses,
//             a comma right before FROM / WHERE / ")" …, a doubled comma,
//             an empty WHERE / AND / OR condition, a misspelled statement or
//             clause keyword (SELCET, FORM, GRUOP BY …)
//   warnings  UPDATE / DELETE without WHERE, JOIN without ON / USING,
//             "= NULL" in a condition, two statements without ";" between them
//
// No DOM imports, so it can be unit-tested with plain Node.

import { tokenize, type FormatDialect, type Tok } from './sqlformat.ts';

export interface SqlProblem {
  from: number;
  to: number;
  severity: 'error' | 'warning';
  message: string;
}

const STATEMENT_START = new Set(
  (
    'SELECT WITH INSERT UPDATE DELETE REPLACE MERGE UPSERT CREATE ALTER DROP TRUNCATE RENAME GRANT REVOKE SET SHOW ' +
    'EXPLAIN DESC DESCRIBE USE BEGIN START COMMIT ROLLBACK SAVEPOINT RELEASE CALL EXEC EXECUTE DECLARE LOCK UNLOCK ' +
    'ANALYZE OPTIMIZE VACUUM COMMENT PREPARE DEALLOCATE LOAD HANDLER DO KILL FLUSH PURGE RESET CHECKSUM REPAIR CHECK ' +
    'VALUES TABLE COPY REINDEX CLUSTER LISTEN NOTIFY UNLISTEN FETCH CLOSE OPEN MOVE END IF ELSE ELSIF ELSEIF LOOP WHILE ' +
    'REPEAT LEAVE ITERATE RETURN PRAGMA SPOOL PROMPT EXIT CONNECT DISCONNECT WHENEVER DELIMITER SOURCE ABORT ' +
    'CHECKPOINT DISCARD IMPORT INSTALL UNINSTALL SHUTDOWN RESTART CACHE BINLOG CHANGE STOP XA GET SIGNAL RESIGNAL ' +
    'AUDIT NOAUDIT ASSOCIATE DISASSOCIATE FLASHBACK PURGE AUTHORIZATION SECURITY REFRESH NULL OR FOR FOREACH CASE ' +
    'WHEN THEN RAISE PERFORM GOTO CONTINUE BREAK PRINT GO VAR VARIABLE DEFINE UNDEFINE COLUMN TTITLE BTITLE SHO ' +
    'DBMS_OUTPUT DBMS_STATS ESTIMATE STATISTICS SECURITY LABEL REASSIGN IMPORT'
  ).split(' '),
);

/** Common keywords a misspelling is compared with (statement start). */
const START_TARGETS = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'EXPLAIN',
  'REPLACE',
];

const CLAUSE_END = new Set([
  'FROM',
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
  'INTO',
  'OFFSET',
  'FETCH',
  'WINDOW',
  'QUALIFY',
  'RETURNING',
]);
const CONDITION_END = new Set([
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
  'OFFSET',
  'FETCH',
  'WINDOW',
  'RETURNING',
  'FOR',
]);
const JOIN_END = new Set([
  'WHERE',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'STRAIGHT_JOIN',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
  'OFFSET',
  'FETCH',
  'WINDOW',
  'FOR',
  'OUTER',
]);
const NEW_STATEMENT = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE']);

/** Optimal string alignment distance (insert / delete / substitute / swap). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

const near = (word: string, target: string) =>
  word !== target &&
  word.length >= 3 &&
  Math.abs(word.length - target.length) <= 1 &&
  editDistance(word, target) <= (target.length >= 6 ? 2 : 1);

export function lintSql(src: string, dialect: FormatDialect = 'mysql'): SqlProblem[] {
  const out: SqlProblem[] = [];
  const toks = tokenize(src, dialect);
  const lineEnd = (pos: number) => {
    const i = src.indexOf('\n', pos);
    return i < 0 ? src.length : i;
  };
  const err = (from: number, to: number, message: string) => out.push({ from, to, severity: 'error', message });
  const warn = (from: number, to: number, message: string) => out.push({ from, to, severity: 'warning', message });

  // ---- tokens: unclosed strings, names, comments --------------------------------------
  for (const t of toks) {
    if (t.e !== src.length) continue;
    if (t.t === 'bc' && !t.v.endsWith('*/')) err(t.s, Math.min(lineEnd(t.s), t.s + 2), '닫히지 않은 주석 (*/ 없음)');
    if (t.t === 'str' || t.t === 'qid') {
      if (t.v.startsWith('$')) {
        const tag = /^\$[A-Za-z_0-9]*\$/.exec(t.v)?.[0] ?? '$$';
        if (t.v.length < tag.length * 2 || !t.v.endsWith(tag)) err(t.s, lineEnd(t.s), `닫히지 않은 ${tag} 문자열`);
        continue;
      }
      const qi = t.v.search(/['"`]/);
      const q = t.v[qi];
      const body = t.v.slice(qi + 1);
      let closed = body.length > 0 && body.endsWith(q);
      if (closed && dialect === 'mysql' && t.t === 'str') {
        const bs = /\\*$/.exec(body.slice(0, -1))![0].length;
        if (bs % 2 === 1) closed = false;
      }
      if (closed) {
        // A run of doubled quotes at the end ('abc''') means the last one is still open.
        const run = /(['"`]+)$/.exec(body)![1].length;
        if (run % 2 === 0) closed = false;
      }
      if (!closed)
        err(t.s, lineEnd(t.s), t.t === 'qid' ? `닫히지 않은 이름 (${q} 없음)` : `닫히지 않은 문자열 (${q} 없음)`);
    }
  }

  // ---- parentheses ------------------------------------------------------------------------
  const code = toks.filter((t) => t.t !== 'lc' && t.t !== 'bc');
  const stack: Tok[] = [];
  for (const t of code) {
    if (t.t === ';') {
      // Parentheses never span statements.
      for (const o of stack) err(o.s, o.e, '닫히지 않은 괄호 "("');
      stack.length = 0;
    } else if (t.t === '(') stack.push(t);
    else if (t.t === ')') {
      if (stack.length) stack.pop();
      else err(t.s, t.e, '여는 괄호 없이 닫는 괄호 ")"가 있습니다');
    }
  }
  for (const t of stack) err(t.s, t.e, '닫히지 않은 괄호 "("');

  // ---- statements ------------------------------------------------------------------------
  if (/^\s*DELIMITER\s/im.test(src)) return dedupe(out);
  for (const st of statements(code)) checkStatement(st, src, dialect, err, warn);
  return dedupe(out);
}

function dedupe(p: SqlProblem[]): SqlProblem[] {
  const seen = new Set<string>();
  return p
    .filter((x) => {
      const k = `${x.from}:${x.to}:${x.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.from - b.from);
}

/** Splits at depth-0 ";" (and Oracle "/" lines are just tokens we ignore). */
function statements(code: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let d = 0;
  for (const t of code) {
    if (t.t === '(') d++;
    if (t.t === ')') d = Math.max(0, d - 1);
    if (t.t === ';' && d === 0) {
      if (cur.length) out.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

const PROCEDURAL = /^(PROCEDURE|FUNCTION|TRIGGER|PACKAGE|EVENT|BEGIN|DECLARE|LOOP|TYPE|BODY)$/;

function checkStatement(
  st: Tok[],
  src: string,
  dialect: FormatDialect,
  err: (f: number, t: number, m: string) => void,
  warn: (f: number, t: number, m: string) => void,
) {
  const first = st[0];
  // Procedural code splits on ";" inside bodies — leave it alone.
  if (st.some((t) => t.t === 'word' && PROCEDURAL.test(t.u))) return;
  if (first.t === 'op' && first.v === '/') return; // SQL*Plus terminator

  // Statement keyword misspelled (only when it is close to a common one).
  if (first.t === 'word' && !STATEMENT_START.has(first.u)) {
    const t = START_TARGETS.find((k) => near(first.u, k));
    if (!t) return; // something we don't know (a client command …): leave it
    err(first.s, first.e, `알 수 없는 명령 "${first.v}" — ${t}의 오타인가요?`);
    first.u = t; // check the rest as if it were spelled right
  }
  if (first.t !== 'word') return;

  // Depth-0 view of the statement with each token's paren depth.
  const depth: number[] = [];
  let d = 0;
  for (const t of st) {
    if (t.t === ')') d = Math.max(0, d - 1);
    depth.push(d);
    if (t.t === '(') d++;
  }
  const isWord = (t: Tok | undefined, ...u: string[]) => !!t && t.t === 'word' && u.includes(t.u);
  const afterDot = (i: number) => st[i - 1]?.t === '.';
  const kw = (i: number) => st[i].t === 'word' && !afterDot(i) && st[i + 1]?.t !== '.' && st[i + 1]?.t !== '(';

  // Misspelled clause keywords.
  for (let i = 1; i < st.length; i++) {
    const t = st[i];
    if (!kw(i)) continue;
    if (isWord(st[i + 1], 'BY') && !['GROUP', 'ORDER', 'PARTITION'].includes(t.u)) {
      const target = ['GROUP', 'ORDER'].find((k) => near(t.u, k));
      if (target && t.u !== 'CLUSTER' && t.u !== 'DISTRIBUTE' && t.u !== 'SORT')
        err(t.s, st[i + 1].e, `"${t.v} BY" — ${target} BY의 오타인가요?`);
    }
  }
  if (first.u === 'SELECT' || first.u === 'WITH') {
    // FROM / WHERE written wrong: the statement has none of them at depth 0.
    const has = (u: string) => st.some((t, i) => depth[i] === 0 && t.t === 'word' && t.u === u && !afterDot(i));
    for (const target of ['FROM', 'WHERE']) {
      if (has(target)) continue;
      for (let i = 1; i < st.length; i++) {
        const t = st[i];
        if (depth[i] !== 0 || !kw(i) || !near(t.u, target)) continue;
        // The misspelt word is followed by a name or a condition, like the keyword would be.
        const next = st[i + 1];
        if (!next || (next.t !== 'word' && next.t !== 'qid' && next.t !== '(')) continue;
        if (isWord(st[i - 1], 'AS')) continue;
        err(t.s, t.e, `"${t.v}" — ${target}의 오타인가요?`);
        break;
      }
    }
  }

  // Commas.
  for (let i = 0; i < st.length; i++) {
    if (st[i].t !== ',') continue;
    const next = st[i + 1];
    if (!next) err(st[i].s, st[i].e, '문장 끝에 남는 쉼표');
    else if (next.t === ',') err(st[i].s, next.e, '쉼표가 두 번 있습니다');
    else if (next.t === ')') err(st[i].s, st[i].e, '닫는 괄호 앞에 남는 쉼표');
    else if (next.t === 'word' && depth[i + 1] === depth[i] && CLAUSE_END.has(next.u) && !afterDot(i + 1))
      // "a, FROM" — but not "INSERT … SELECT a, (…)" or names like `limit` quoted
      err(st[i].s, st[i].e, `${next.u} 앞에 남는 쉼표`);
  }

  // Empty conditions.
  for (let i = 0; i < st.length; i++) {
    const t = st[i];
    if (!kw(i) || !['WHERE', 'AND', 'OR', 'ON', 'HAVING'].includes(t.u)) continue;
    if (t.u === 'ON' && !isJoinOn(st, i)) continue;
    if ((t.u === 'AND' || t.u === 'OR') && isWord(st[i - 1], 'BETWEEN')) continue;
    const next = st[i + 1];
    const empty =
      !next ||
      next.t === ')' ||
      (next.t === 'word' &&
        !afterDot(i + 1) &&
        (CONDITION_END.has(next.u) || NEW_STATEMENT.has(next.u) || ['AND', 'OR', 'WHERE'].includes(next.u)) &&
        depth[i + 1] === depth[i]);
    if (empty) err(t.s, t.e, `${t.u} 뒤에 조건이 없습니다`);
    if ((t.u === 'WHERE' || t.u === 'HAVING' || t.u === 'ON') && isWord(next, 'AND', 'OR'))
      err(next!.s, next!.e, `${t.u} 바로 뒤에 ${next!.u}가 있습니다`);
  }

  // UPDATE / DELETE without WHERE.
  if (first.u === 'UPDATE' || first.u === 'DELETE') {
    const hasWhere = st.some((t, i) => depth[i] === 0 && isWord(t, 'WHERE') && !afterDot(i));
    if (!hasWhere)
      warn(
        first.s,
        first.e,
        `WHERE 없는 ${first.u} — 테이블의 모든 행이 ${first.u === 'UPDATE' ? '바뀝' : '삭제됩'}니다`,
      );
  }

  // JOIN without ON / USING (not CROSS / NATURAL).
  for (let i = 0; i < st.length; i++) {
    if (!isWord(st[i], 'JOIN', 'STRAIGHT_JOIN') || afterDot(i)) continue;
    let k = i - 1;
    while (isWord(st[k], 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER')) k--;
    if (isWord(st[k], 'CROSS', 'NATURAL') || isWord(st[i - 1], 'CROSS', 'NATURAL')) continue;
    if (isWord(st[k], 'LATERAL') || isWord(st[i + 1], 'LATERAL')) continue;
    let j = i + 1;
    let found = false;
    for (; j < st.length; j++) {
      if (depth[j] !== depth[i]) continue;
      const t = st[j];
      if (isWord(t, 'ON', 'USING') && !afterDot(j)) {
        found = true;
        break;
      }
      if ((t.t === 'word' && JOIN_END.has(t.u) && !afterDot(j)) || t.t === ',' || t.t === ')') break;
    }
    if (!found) warn(st[i].s, st[i].e, 'ON / USING 없는 JOIN — 모든 행의 조합(카티션 곱)이 만들어집니다');
  }

  // "= NULL" / "<> NULL" in conditions.
  let inCondition = false;
  for (let i = 0; i < st.length; i++) {
    const t = st[i];
    if (t.t === 'word' && !afterDot(i)) {
      if (['WHERE', 'ON', 'HAVING', 'WHEN'].includes(t.u)) inCondition = true;
      else if (['SET', 'SELECT', 'VALUES', 'FROM', 'GROUP', 'ORDER', 'THEN', 'ELSE'].includes(t.u)) inCondition = false;
    }
    if (inCondition && t.t === 'op' && ['=', '<>', '!='].includes(t.v) && isWord(st[i + 1], 'NULL'))
      warn(
        t.s,
        st[i + 1].e,
        `${t.v} NULL은 참이 되지 않습니다(결과가 NULL) — ${t.v === '=' ? 'IS NULL' : 'IS NOT NULL'}을 쓰세요`,
      );
  }

  // A new statement on its own line without ";" before it.
  if (first.u === 'SELECT' || first.u === 'UPDATE' || first.u === 'DELETE') {
    for (let i = 1; i < st.length; i++) {
      const t = st[i];
      if (depth[i] !== 0 || t.t !== 'word' || !NEW_STATEMENT.has(t.u) || afterDot(i)) continue;
      const lineStart = src.lastIndexOf('\n', t.s - 1) + 1;
      if (src.slice(lineStart, t.s).trim()) continue; // not at the start of a line
      const p = st[i - 1];
      if (
        p.t === '(' ||
        isWord(
          p,
          'UNION',
          'ALL',
          'DISTINCT',
          'EXCEPT',
          'INTERSECT',
          'MINUS',
          'AS',
          'FOR',
          'OR',
          'ON',
          'THEN',
          'ELSE',
          'BEGIN',
        )
      )
        continue;
      if (first.u === 'SELECT' && t.u === 'UPDATE' && isWord(p, 'FOR')) continue;
      warn(t.s, t.e, `앞 문장 끝에 ; 가 없습니다 — 두 문장이 하나로 이어집니다`);
      break;
    }
  }
  void dialect;
}

/** ON that belongs to a join (not "ON DUPLICATE KEY", "ON UPDATE", "ON DELETE", "GRANT … ON"). */
function isJoinOn(st: Tok[], i: number): boolean {
  const next = st[i + 1];
  if (
    next &&
    next.t === 'word' &&
    ['DUPLICATE', 'UPDATE', 'DELETE', 'COMMIT', 'CONFLICT', 'SCHEDULE', 'TABLE'].includes(next.u)
  )
    return false;
  const firstU = st[0].u;
  return ['SELECT', 'WITH', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE', 'CREATE', 'MERGE'].includes(firstU);
}
