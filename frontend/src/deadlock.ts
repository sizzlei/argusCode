// Deadlock report parser — MySQL / PostgreSQL / Oracle.
//
//   MySQL       SHOW ENGINE INNODB STATUS (LATEST DETECTED DEADLOCK) or the error
//               log with innodb_print_all_deadlocks (MY-012468 …)
//   PostgreSQL  server log: "ERROR:  deadlock detected" + DETAIL lines
//   Oracle      ORA-00060 trace file: "Deadlock graph" + session information
//
// Produces transactions with the locks they hold / wait for, the wait-for
// edges between them, and plain-language hints about the likely cause.
// No dependencies, so it can be unit-tested with plain Node.

export type DlDb = 'mysql' | 'postgresql' | 'oracle';

export interface DlLock {
  /** Short label of the lock mode, e.g. "X 레코드", "S 넥스트키", "ShareLock". */
  mode: string;
  /** What is locked, e.g. "shop.orders · PRIMARY", "트랜잭션 9001", "TX-000A0012-…". */
  target: string;
  /** Key values of the locked records (MySQL) or other details. */
  details: string[];
  /** 0-based source line; -1 when unknown. */
  line: number;
  /** Lock was not printed but inferred from the other transaction's wait. */
  inferred?: boolean;
  // Matching / analysis
  key: string;
  heaps?: string[];
  table?: string;
  index?: string;
  flags: Set<DlLockFlag>;
}

export type DlLockFlag = 'gap' | 'next' | 'rec' | 'ii' | 'supremum' | 'table' | 'S' | 'X';

export interface DlTxn {
  /** Display name: "(1)", "PID 12345", "SID 123". */
  name: string;
  meta: [string, string][];
  sql?: string;
  sqlLine: number;
  holds: DlLock[];
  waits: DlLock[];
  victim: boolean;
  line: number;
}

export interface DlEdge {
  /** Index of the waiting transaction. */
  from: number;
  /** Index of the transaction holding the lock. */
  to: number;
  lock?: DlLock;
}

export interface Deadlock {
  db: DlDb;
  time?: string;
  txns: DlTxn[];
  edges: DlEdge[];
  hints: string[];
  victimNote?: string;
  /** First source line of the report (0-based). */
  line: number;
}

export const DB_LABEL: Record<DlDb, string> = {
  mysql: 'MySQL InnoDB',
  postgresql: 'PostgreSQL',
  oracle: 'Oracle',
};

/** Cheap check used before loading the plan parser. */
export function looksLikeDeadlock(text: string): boolean {
  const head = text.length > 400000 ? text.slice(0, 400000) : text;
  return (
    /\*\*\* \(1\) TRANSACTION/.test(head) ||
    /deadlock detected/i.test(head) ||
    /DEADLOCK DETECTED|Deadlock graph:/.test(head)
  );
}

/** Every deadlock found in the text, in source order. */
export function parseDeadlocks(text: string): Deadlock[] {
  if (!looksLikeDeadlock(text)) return [];
  let src = text;
  let jump = true;
  // mysql client table output keeps "\n" escaped on a single line.
  if (!/^\*\*\* \(1\) TRANSACTION/m.test(src) && /\\n\*\*\* \(1\) TRANSACTION/.test(src)) {
    src = src.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    jump = false;
  }
  const lines = src.split(/\r?\n/);
  let out: Deadlock[] = [];
  if (/\*\*\* \(1\) TRANSACTION/.test(src)) out = parseMysql(lines);
  else if (/DEADLOCK DETECTED|Deadlock graph:/.test(src)) out = parseOracle(lines);
  else out = parsePostgres(lines);
  if (!jump) for (const d of out) noLines(d);
  for (const d of out) {
    d.hints = d.db === 'mysql' ? mysqlHints(d) : d.db === 'postgresql' ? pgHints(d) : oraHints(d);
    const shapes = d.txns.map((t) => (t.sql ? sqlShape(t.sql) : ''));
    if (shapes.length > 1 && shapes[0] && shapes.every((x) => x === shapes[0])) {
      d.hints.push(
        '모든 트랜잭션이 같은 형태의 문장을 실행했습니다(값만 다름). 같은 코드가 동시에 실행되며 서로 막힌 경우입니다. 동시에 들어온 요청(배치 병렬 처리, 재시도, 중복 요청)이 같은 행이나 범위를 다른 순서로 건드리는지 확인하세요.',
      );
    }
  }
  return out.filter((d) => d.txns.length > 0);
}

/** Statement with literals and binds replaced, for comparing statements. */
function sqlShape(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/(?<![\w$])(?::\w+|\$\d+|-?\d+(?:\.\d+)?)(?![\w$])/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function noLines(d: Deadlock) {
  d.line = -1;
  for (const t of d.txns) {
    t.line = -1;
    t.sqlLine = -1;
    for (const l of [...t.holds, ...t.waits]) l.line = -1;
  }
}

// ---- MySQL ----------------------------------------------------------------------------

const MY_LOG_PREFIX = /^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d)\s+\d+\s+\[\w+\]\s+\[MY-\d+\]\s+\[InnoDB\]\s?/;

function parseMysql(raw: string[]): Deadlock[] {
  const lines = raw.map((l) => l.replace(MY_LOG_PREFIX, ''));
  const out: Deadlock[] = [];
  let d: Deadlock | null = null;
  let txn: DlTxn | null = null;
  let section: 'head' | 'holds' | 'waits' | null = null;
  let lock: DlLock | null = null;
  let rec: { heap: string; fields: { len: number; hex?: string; asc?: string; nul?: boolean }[] } | null = null;
  let pendingTime: string | undefined;
  let pendingLine = -1;

  const flushRec = () => {
    if (lock && rec) {
      lock.details.push(describeRecord(rec, lock.index));
      if (rec.fields.length === 1 && rec.fields[0].asc === 'supremum') lock.flags.add('supremum');
    }
    rec = null;
  };
  const flushLock = () => {
    flushRec();
    lock = null;
  };
  const finish = () => {
    flushLock();
    if (d) {
      linkMysql(d);
      out.push(d);
    }
    d = null;
    txn = null;
    section = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = l.trim();
    if (/^LATEST DETECTED DEADLOCK$/.test(t) || /Transactions deadlock detected/.test(raw[i])) {
      pendingLine = i;
      const ts = raw[i].match(/^(\d{4}-\d\d-\d\dT[\d:]+)/);
      pendingTime = ts ? ts[1].replace('T', ' ') : undefined;
      continue;
    }
    if (pendingLine >= 0 && !pendingTime && !d) {
      const ts = t.match(/^(\d{4}-\d\d-\d\d[ T][\d:]+)\s/);
      if (ts) pendingTime = ts[1].replace('T', ' ');
    }
    let m = t.match(/^\*\*\* \((\d+)\) TRANSACTION:?$/);
    if (m) {
      flushLock();
      if (m[1] === '1' && d) finish();
      if (!d) {
        d = {
          db: 'mysql',
          time: pendingTime,
          txns: [],
          edges: [],
          hints: [],
          line: pendingLine >= 0 ? pendingLine : i,
        };
        pendingTime = undefined;
        pendingLine = -1;
      }
      txn = { name: `(${m[1]})`, meta: [], sqlLine: -1, holds: [], waits: [], victim: false, line: i };
      d.txns.push(txn);
      section = 'head';
      continue;
    }
    m = t.match(/^\*\*\* \((\d+)\) (HOLDS THE LOCK\(S\)|WAITING FOR THIS LOCK TO BE GRANTED):?$/);
    if (m && d) {
      flushLock();
      txn = d.txns.find((x) => x.name === `(${m![1]})`) ?? txn;
      section = m[2].startsWith('HOLDS') ? 'holds' : 'waits';
      continue;
    }
    m = t.match(/^\*\*\* WE ROLL BACK TRANSACTION \((\d+)\)/);
    if (m && d) {
      const v = d.txns.find((x) => x.name === `(${m![1]})`);
      if (v) {
        v.victim = true;
        d.victimNote = `InnoDB가 트랜잭션 ${v.name}을 롤백했습니다(되돌릴 변경이 적은 쪽). 해당 세션은 오류 1213(ER_LOCK_DEADLOCK)을 받으므로 애플리케이션에서 트랜잭션 전체를 다시 실행해야 합니다.`;
      }
      finish();
      continue;
    }
    if (!d || !txn) continue;
    // End of the deadlock section in SHOW ENGINE INNODB STATUS.
    if (/^-{6,}$/.test(t) && /^[A-Z ]+$/.test(lines[i + 1]?.trim() ?? '') && lines[i + 1].trim() !== '') {
      finish();
      continue;
    }

    if (section === 'head') {
      if (!t) continue;
      if ((m = t.match(/^TRANSACTION (\d+), ACTIVE (\d+) sec\s*(.*)$/))) {
        txn.meta.push(['트랜잭션 ID', m[1]], ['활성 시간', m[2] + '초']);
        if (m[3]) txn.meta.push(['상태', m[3]]);
      } else if (
        (m = t.match(
          /^(?:LOCK WAIT )?(\d+) lock struct\(s\), heap size \d+, (\d+) row lock\(s\)(?:, undo log entries (\d+))?/,
        ))
      ) {
        txn.meta.push(['잠근 행', m[2]]);
        if (m[3]) txn.meta.push(['변경 행(undo)', m[3]]);
      } else if ((m = t.match(/^MySQL thread id (\d+), OS thread handle \S+, query id \d+\s*(.*)$/))) {
        txn.meta.push(['스레드 ID', m[1]]);
        const p = m[2].split(/\s+/).filter(Boolean);
        if (p.length) txn.meta.push(['접속', p.slice(0, 2).join(' ')]);
        if (p.length > 2) txn.meta.push(['스레드 상태', p.slice(2).join(' ')]);
      } else if (/^mysql tables in use/.test(t) || /^TRANSACTION \d+/.test(t)) {
        // not interesting
      } else {
        txn.sql = txn.sql ? txn.sql + '\n' + l : l;
        if (txn.sqlLine < 0) txn.sqlLine = i;
      }
      continue;
    }

    // Lock sections
    if (
      (m = t.match(
        /^RECORD LOCKS space id (\d+) page no (\d+) n bits \d+ index `?([^` ]+)`? of table (\S+) trx id \d+ (.*)$/,
      ))
    ) {
      flushLock();
      lock = myLock(m[5], `${m[1]}:${m[2]}`, unq(m[4]), m[3], i, false);
      (section === 'holds' ? txn.holds : txn.waits).push(lock);
      continue;
    }
    if ((m = t.match(/^TABLE LOCK table (\S+) trx id \d+ (.*)$/))) {
      flushLock();
      lock = myLock(m[2], 'table:' + unq(m[1]), unq(m[1]), undefined, i, true);
      (section === 'holds' ? txn.holds : txn.waits).push(lock);
      continue;
    }
    if ((m = t.match(/^Record lock, heap no (\d+)/))) {
      flushRec();
      if (lock) {
        rec = { heap: m[1], fields: [] };
        lock.heaps!.push(m[1]);
      }
      continue;
    }
    if (
      rec &&
      (m = l.match(
        /^\s*(\d+): (?:len (\d+); hex ([0-9a-f]*)(?:\.\.\.)?(?:\s*\(total \d+ bytes\))?; asc (.*?);;|SQL NULL;)/,
      ))
    ) {
      rec.fields.push(m[2] == null ? { len: 0, nul: true } : { len: +m[2], hex: m[3], asc: m[4] });
      continue;
    }
  }
  finish();
  return out;
}

const unq = (s: string) => s.replace(/`/g, '');

function myLock(
  modeText: string,
  space: string,
  table: string,
  index: string | undefined,
  line: number,
  isTable: boolean,
): DlLock {
  const mt = modeText.replace(/\s+waiting\s*$/, '');
  const mm = mt.match(/lock[_ ]mode (AUTO-INC|[A-Z]+)/);
  const base = mm ? mm[1] : mt;
  const flags = new Set<DlLockFlag>();
  if (base === 'S' || base === 'X') flags.add(base);
  let kind: string;
  if (isTable) {
    flags.add('table');
    kind = '테이블';
  } else if (/insert intention/.test(mt)) {
    flags.add('ii');
    kind = 'INSERT 의도';
  } else if (/locks gap before rec/.test(mt)) {
    flags.add('gap');
    kind = '갭';
  } else if (/locks rec but not gap/.test(mt)) {
    flags.add('rec');
    kind = '레코드';
  } else {
    flags.add('next');
    kind = '넥스트키';
  }
  return {
    mode: `${base} ${kind}`,
    target: index ? `${table} · ${index}` : table,
    details: [],
    line,
    key: space,
    heaps: [],
    table,
    index,
    flags,
  };
}

/** Readable key values of a locked index record. */
function describeRecord(
  rec: { heap: string; fields: { len: number; hex?: string; asc?: string; nul?: boolean }[] },
  index?: string,
): string {
  const f = rec.fields;
  if (f.length === 1 && f[0].asc === 'supremum') return 'supremum — 인덱스의 마지막 값 뒤 (끝 범위)';
  let keyN = f.length;
  if (index === 'PRIMARY' || index === 'GEN_CLUST_INDEX') {
    // Clustered index: key columns, DB_TRX_ID (6 bytes), DB_ROLL_PTR (7 bytes), other columns.
    const k = f.findIndex((x, i) => x.len === 6 && f[i + 1]?.len === 7);
    if (k > 0) keyN = k;
  }
  const vals = f
    .slice(0, Math.min(keyN, 6))
    .map((x) => (x.nul ? 'NULL' : decodeField(x.hex ?? '', x.len, x.asc ?? '')));
  if (keyN > 6) vals.push('…');
  if (!vals.length) return `heap ${rec.heap} (값 없음)`;
  const v = vals.length === 1 ? vals[0] : `(${vals.join(', ')})`;
  // Secondary index records hold the index columns followed by the PK columns.
  return index === 'PRIMARY' || index === 'GEN_CLUST_INDEX' ? `PK = ${v}` : `키 = ${v}  (인덱스 컬럼 + PK)`;
}

/** Best-effort decoding of an InnoDB key field (memcmp format). */
export function decodeField(hex: string, len: number, asc: string): string {
  if (!hex) return asc.trim() ? `'${asc.trim()}'` : "''";
  const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
  const top = bytes[0] >= 0x80;
  // DATETIME(fsp): 5..8 bytes, sign bit set, plausible year.
  if (top && len >= 5 && len <= 7) {
    const dt = decodeDatetime(hex.slice(0, 10));
    if (dt) return dt;
  }
  if ([1, 2, 3, 4, 8].includes(len) && len === bytes.length) {
    const v = BigInt('0x' + hex);
    const n = top ? v - (1n << BigInt(len * 8 - 1)) : v;
    if (top || bytes.some((b) => b < 0x20 || b > 0x7e)) return n.toString();
  }
  // Text: try UTF-8.
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    if (!/[\u0000-\u001f\u007f]/.test(s)) return `'${s.replace(/\s+$/, '')}'`;
  } catch {
    // not text
  }
  return '0x' + hex + (len > bytes.length ? '…' : '');
}

function decodeDatetime(hex10: string): string | null {
  if (hex10.length < 10) return null;
  let v = BigInt('0x' + hex10) - 0x8000000000n;
  if (v < 0n) return null;
  const hms = Number(v & 0x1ffffn);
  v >>= 17n;
  const day = Number(v & 31n);
  const ym = Number(v >> 5n);
  const year = Math.floor(ym / 13);
  const month = ym % 13;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const sec = hms & 63;
  const min = (hms >> 6) & 63;
  const hour = hms >> 12;
  if (hour > 23 || min > 59 || sec > 59) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `'${year}-${p(month)}-${p(day)} ${p(hour)}:${p(min)}:${p(sec)}'`;
}

function sameResource(a: DlLock, b: DlLock): boolean {
  if (a.key !== b.key) return false;
  if (!a.heaps?.length || !b.heaps?.length) return true;
  return a.heaps.some((h) => b.heaps!.includes(h));
}

function linkMysql(d: Deadlock) {
  const n = d.txns.length;
  // MySQL 5.7 prints no "HOLDS" for the first transaction: it holds what the other waits for.
  if (n === 2) {
    for (const [a, b] of [
      [0, 1],
      [1, 0],
    ]) {
      const ta = d.txns[a];
      const tb = d.txns[b];
      if (!ta.holds.length && tb.waits.length) {
        ta.holds = tb.waits.map((w) => {
          const flags = new Set<DlLockFlag>();
          if (w.flags.has('ii')) flags.add('gap');
          return {
            ...w,
            mode: w.flags.has('ii') ? '갭 / 넥스트키 (추정)' : '충돌하는 락 (추정)',
            details: [...w.details, '로그에 출력되지 않음 — 상대가 기다리는 락으로 추정'],
            inferred: true,
            line: -1,
            flags,
          };
        });
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const w = d.txns[i].waits[0];
    if (!w) continue;
    let to = -1;
    for (let j = 0; j < n && to < 0; j++) {
      if (j !== i && d.txns[j].holds.some((h) => sameResource(h, w))) to = j;
    }
    if (to < 0) to = (i + 1) % n; // printed in cycle order
    if (to !== i) d.edges.push({ from: i, to, lock: w });
  }
}

function mysqlHints(d: Deadlock): string[] {
  const h: string[] = [];
  const all = d.txns.flatMap((t) => [...t.holds, ...t.waits]);
  const waits = d.txns.flatMap((t) => t.waits);
  const has = (f: string, list = all) => list.some((l) => l.flags.has(f as never));
  if (has('ii', waits) && (has('gap') || has('next') || has('supremum'))) {
    h.push(
      '갭 락과 INSERT 의도 락의 충돌입니다. 두 트랜잭션이 같은 범위를 먼저 잠근 뒤(SELECT … FOR UPDATE, 범위 조건 UPDATE/DELETE, 없는 키 조회) 그 범위에 INSERT하려다 서로 막혔습니다. "있는지 확인 후 INSERT" 패턴이면 INSERT … ON DUPLICATE KEY UPDATE로 바꾸거나, 격리 수준을 READ COMMITTED로 낮춰 갭 락을 없애는 방법을 검토하세요.',
    );
  }
  if (has('supremum')) {
    h.push(
      'supremum(인덱스 끝) 레코드가 잠겼습니다. 마지막 값 뒤의 범위 전체가 잠기므로, 증가하는 키의 끝에 INSERT하거나 범위 끝까지 조회하는 트랜잭션끼리 자주 부딪힙니다.',
    );
  }
  // S → X upgrade on the same record
  const upgrade = d.txns.some((t) =>
    t.waits.some((w) => w.flags.has('X') && t.holds.some((hl) => hl.flags.has('S') && sameResource(hl, w))),
  );
  if (upgrade) {
    h.push(
      '같은 행에 공유(S) 락을 잡은 트랜잭션들이 배타(X) 락으로 올리려다 교착되었습니다. 중복 키 INSERT(유니크 검사로 S 락) 뒤 UPDATE, 또는 LOCK IN SHARE MODE / FOR SHARE로 읽은 뒤 수정하는 경우입니다. 수정할 행은 처음부터 FOR UPDATE로 잠그세요.',
    );
  } else if (waits.some((w) => w.flags.has('S') && !w.flags.has('table'))) {
    h.push(
      '공유(S) 락을 기다리고 있습니다. INSERT의 유니크 키 중복 검사나 외래키 검사에서 걸리는 락입니다. 같은 키를 동시에 INSERT하는지, 부모 행을 수정하는 동안 자식 행을 INSERT하는지 확인하세요.',
    );
  }
  const tables = new Set(
    all
      .filter((l) => !l.inferred)
      .map((l) => l.table)
      .filter(Boolean),
  );
  const recLocks = all.filter((l) => !l.flags.has('table'));
  if (tables.size > 1) {
    h.push(
      `여러 테이블(${[...tables].join(', ')})을 트랜잭션마다 다른 순서로 수정했습니다. 모든 코드 경로에서 테이블 접근 순서를 통일하세요.`,
    );
  } else if (
    recLocks.length &&
    recLocks.every((l) => l.flags.has('rec') || l.flags.has('next')) &&
    !upgrade &&
    !has('ii', waits)
  ) {
    h.push(
      '같은 테이블의 행을 트랜잭션마다 다른 순서로 잠갔습니다. 여러 행을 수정할 때는 PK 순서(예: id 오름차순)로 처리하거나, 한 문장으로 묶어 잠금 순서를 고정하세요.',
    );
  }
  const idx = new Set(recLocks.map((l) => l.index).filter(Boolean));
  if (idx.size > 1 && tables.size === 1) {
    const sec = [...idx].filter((x) => x !== 'PRIMARY');
    h.push(
      `같은 테이블을 서로 다른 인덱스(${[...idx].join(', ')})로 잠갔습니다. 보조 인덱스(${sec.join(', ')})로 찾은 행은 보조 인덱스 → PK 순서로 잠기므로, PK로 접근하는 다른 트랜잭션과 순서가 엇갈릴 수 있습니다.`,
    );
  }
  if (waits.some((w) => w.flags.has('table'))) {
    h.push('테이블 락을 기다리고 있습니다. LOCK TABLES나 DDL, AUTO-INC 락이 관여했는지 확인하세요.');
  }
  const long = d.txns
    .map((t) => [t.name, t.meta.find(([k]) => k === '활성 시간')?.[1] ?? ''] as const)
    .filter(([, a]) => parseInt(a) >= 10);
  if (long.length) {
    h.push(
      `오래 열린 트랜잭션이 있습니다(${long.map(([n, a]) => `${n} ${a}`).join(', ')}). 긴 트랜잭션은 락을 오래 잡고 있어 교착 확률을 높입니다. 트랜잭션 안에서 외부 호출이나 사용자 입력을 기다리지 않는지 확인하세요.`,
    );
  }
  if (!h.length)
    h.push(
      '트랜잭션들이 서로가 잡은 락을 기다리며 순환이 생겼습니다. 아래 대기 관계에서 각 트랜잭션이 잠그는 순서를 확인하세요.',
    );
  return h;
}

// ---- PostgreSQL --------------------------------------------------------------------------

const PG_LEVEL = /(?:^|\s|:)(LOG|ERROR|DETAIL|HINT|CONTEXT|STATEMENT|FATAL|WARNING|NOTICE|INFO|DEBUG\d?):\s\s?/;

function parsePostgres(lines: string[]): Deadlock[] {
  const out: Deadlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/ERROR:\s+deadlock detected/i.test(lines[i]) && !/^deadlock detected/i.test(lines[i].trim())) continue;
    const errLine = lines[i];
    const prefix = errLine.slice(0, errLine.search(/ERROR:|deadlock detected/i));
    const pidM = prefix.match(/\[(\d+)\]/);
    const timeM = prefix.match(/(\d{4}-\d\d-\d\d[ T][\d:]+)/);
    const d: Deadlock = { db: 'postgresql', time: timeM?.[1], txns: [], edges: [], hints: [], line: i };
    const byPid = new Map<string, DlTxn>();
    const get = (pid: string, line: number) => {
      let t = byPid.get(pid);
      if (!t) {
        t = {
          name: 'PID ' + pid,
          meta: [['프로세스 ID', pid]],
          sqlLine: -1,
          holds: [],
          waits: [],
          victim: false,
          line,
        };
        byPid.set(pid, t);
        d.txns.push(t);
      }
      return t;
    };
    let context = '';
    let statement = '';
    let lastSql: DlTxn | null = null;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      const lv = l.match(PG_LEVEL);
      // Another log entry from a different message ends the block.
      if (lv && !['DETAIL', 'HINT', 'CONTEXT', 'STATEMENT'].includes(lv[1])) break;
      const body = lv ? l.slice(l.indexOf(lv[1] + ':') + lv[1].length + 1).trim() : l.trim();
      if (lv && lv[1] === 'CONTEXT') {
        context = body;
        lastSql = null;
        continue;
      }
      if (lv && lv[1] === 'STATEMENT') {
        statement = body;
        lastSql = null;
        continue;
      }
      if (lv && lv[1] === 'HINT') {
        lastSql = null;
        continue;
      }
      let m = body.match(/^Process (\d+) waits for (\S+) on (.+?); blocked by process (\d+)\.?$/);
      if (m) {
        const w = get(m[1], j);
        const b = get(m[4], j);
        const lock = pgLock(m[2], m[3], j);
        w.waits.push(lock);
        b.holds.push(pgHeld(lock));
        d.edges.push({ from: d.txns.indexOf(w), to: d.txns.indexOf(b), lock });
        lastSql = null;
        continue;
      }
      m = body.match(/^Process (\d+): (.*)$/);
      if (m) {
        const t = get(m[1], j);
        t.sql = m[2];
        t.sqlLine = j;
        lastSql = t;
        continue;
      }
      if (lastSql && body && !lv) {
        lastSql.sql += '\n' + l.replace(/^\t/, '');
        continue;
      }
      if (!body && !lv) continue;
      if (!lv) break;
    }
    const pid = pidM?.[1];
    let victim = pid ? byPid.get(pid) : undefined;
    if (!victim && statement) victim = d.txns.find((t) => t.sql?.trim() === statement.trim());
    if (victim) {
      victim.victim = true;
      if (context) victim.meta.push(['CONTEXT', context]);
      d.victimNote = `PostgreSQL이 ${victim.name}의 트랜잭션을 중단했습니다(deadlock_timeout 뒤 교착을 발견한 쪽). 해당 세션은 오류 40P01을 받으므로 트랜잭션 전체를 다시 실행해야 합니다.`;
    } else if (context) {
      d.txns[0]?.meta.push(['CONTEXT', context]);
    }
    if (!d.txns.some((t) => t.sql)) {
      d.txns.forEach((t) => {
        if (!t.sql && t.victim && statement) t.sql = statement;
      });
    }
    out.push(d);
    i = j - 1;
  }
  return out;
}

/** What the blocking process holds, derived from the waiter's lock. */
function pgHeld(l: DlLock): DlLock {
  const xid = l.target.match(/^트랜잭션 (\d+)/)?.[1];
  if (xid)
    return {
      ...l,
      mode: 'ExclusiveLock',
      target: `자기 트랜잭션 ${xid}`,
      details: ['이 트랜잭션이 수정했거나 FOR UPDATE로 잠근 행을 상대가 기다림'],
      inferred: true,
      line: -1,
      flags: new Set(['X']),
    };
  return { ...l, mode: '충돌하는 락 (추정)', details: [], inferred: true, line: -1, flags: new Set(l.flags) };
}

function pgLock(mode: string, what: string, line: number): DlLock {
  const flags = new Set<DlLockFlag>();
  let target = what;
  const details: string[] = [];
  let m: RegExpMatchArray | null;
  if ((m = what.match(/^transaction (\d+)$/))) {
    target = '트랜잭션 ' + m[1];
    details.push('상대 트랜잭션이 수정한 행 — 그 트랜잭션이 끝나기를 기다림 (행 락)');
  } else if ((m = what.match(/^tuple \((\d+),(\d+)\) of relation (\d+) of database (\d+)$/))) {
    target = `relation ${m[3]} · tuple (${m[1]},${m[2]})`;
    details.push(`행 위치 ctid = '(${m[1]},${m[2]})'`);
  } else if ((m = what.match(/^relation (\d+) of database (\d+)$/))) {
    target = 'relation ' + m[1];
    flags.add('table');
  } else if ((m = what.match(/^advisory lock \[(.+)\]$/))) {
    target = 'advisory lock [' + m[1] + ']';
  } else if ((m = what.match(/^extension of relation (\d+)/))) {
    target = 'relation ' + m[1] + ' 확장';
  }
  if (/Exclusive/.test(mode)) flags.add('X');
  else if (/Share/.test(mode)) flags.add('S');
  return { mode, target, details, line, key: what, flags };
}

function pgHints(d: Deadlock): string[] {
  const h: string[] = [];
  const waits = d.txns.flatMap((t) => t.waits);
  const ctx = d.txns.flatMap((t) => t.meta.filter(([k]) => k === 'CONTEXT').map(([, v]) => v)).join(' ');
  const sql = d.txns.map((t) => t.sql ?? '').join('\n');
  if (waits.length && waits.every((w) => /^트랜잭션|tuple/.test(w.target))) {
    h.push(
      '행 락 교착입니다. 각 프로세스가 상대가 이미 수정(또는 FOR UPDATE)한 행을 기다립니다. 여러 행을 수정할 때 PK 순서로 처리하거나(예: ORDER BY id … FOR UPDATE로 먼저 잠금) 한 문장으로 묶어 잠금 순서를 고정하세요.',
    );
  }
  if (/FOR KEY SHARE|FOR SHARE|SELECT 1 FROM ONLY/i.test(ctx + sql)) {
    h.push(
      '외래키 검사(FOR KEY SHARE)가 관여했습니다. 부모 행을 수정하는 트랜잭션과 자식 행을 INSERT/UPDATE하는 트랜잭션이 엇갈렸을 가능성이 큽니다. 부모 → 자식 순서로 처리하도록 맞추세요.',
    );
  }
  if (waits.some((w) => w.flags.has('table'))) {
    h.push(
      `테이블 수준 락(${[...new Set(waits.filter((w) => w.flags.has('table')).map((w) => w.mode))].join(', ')})이 관여했습니다. ALTER TABLE, LOCK TABLE, TRUNCATE, VACUUM FULL, CREATE INDEX(CONCURRENTLY 아님) 같은 명령을 다른 트랜잭션 도중에 실행하지 않았는지 확인하세요.`,
    );
  }
  if (waits.some((w) => w.target.startsWith('advisory'))) {
    h.push('advisory lock을 잡는 순서가 프로세스마다 다릅니다. pg_advisory_lock 호출 순서를 키 순서로 통일하세요.');
  }
  const oids = [...new Set(waits.map((w) => w.target.match(/relation (\d+)/)?.[1]).filter(Boolean))];
  if (oids.length) {
    h.push(
      `relation 번호(OID)의 테이블 이름은 해당 DB에서 확인하세요: SELECT ${oids.map((o) => `${o}::regclass`).join(', ')};`,
    );
  }
  if (!d.txns.some((t) => t.sql)) {
    h.push(
      '쿼리 문장이 없습니다. 클라이언트 오류 메시지가 아닌 서버 로그(log_lock_waits = on 권장)를 붙여 넣으면 프로세스별 쿼리까지 보입니다.',
    );
  }
  if (!h.length) h.push('프로세스들이 서로가 잡은 락을 기다리며 순환이 생겼습니다. 아래 대기 관계를 확인하세요.');
  return h;
}

// ---- Oracle ------------------------------------------------------------------------------

function parseOracle(lines: string[]): Deadlock[] {
  const out: Deadlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*Deadlock graph:/.test(lines[i])) continue;
    // Report header (time, this session) above the graph.
    let start = i;
    let time: string | undefined;
    let thisSid: string | undefined;
    for (let k = i; k >= 0 && k > i - 80; k--) {
      const l = lines[k];
      if (/DEADLOCK DETECTED/.test(l) && start === i) start = k;
      const tm = l.match(/^\*\*\* (\d{4}-\d\d-\d\d[T ][\d:]+)/);
      if (tm && !time) time = tm[1].replace('T', ' ');
      const sm = l.match(/^\*\*\* SESSION ID:\((\d+)\.(\d+)\)/);
      if (sm && !thisSid) thisSid = sm[1];
      if (k < i && /^\s*Deadlock graph:/.test(l)) break;
    }
    const d: Deadlock = { db: 'oracle', time, txns: [], edges: [], hints: [], line: start };
    const bySid = new Map<string, DlTxn>();
    const get = (sid: string, line: number) => {
      let t = bySid.get(sid);
      if (!t) {
        t = { name: 'SID ' + sid, meta: [], sqlLine: -1, holds: [], waits: [], victim: false, line };
        bySid.set(sid, t);
        d.txns.push(t);
      }
      return t;
    };
    // Graph table
    let h = i + 1;
    while (h < lines.length && !/Resource Name/.test(lines[h])) h++;
    const header = lines[h] ?? '';
    const cols: { name: string; s: number; e: number }[] = [];
    for (const m of header.matchAll(/process|session|holds|waits|serial/g))
      cols.push({ name: m[0], s: m.index!, e: m.index! + m[0].length });
    const half = cols.findIndex((c, k) => k > 0 && c.name === 'process');
    let j = h + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) break;
      const toks = [...l.matchAll(/\S+/g)].map((m) => ({ v: m[0], s: m.index!, e: m.index! + m[0].length }));
      if (!toks.length || !/^[A-Z]{2}-/.test(toks[0].v)) break;
      const res = toks[0].v;
      const cell: Record<string, string> = {};
      for (const t of toks.slice(1)) {
        let best = -1;
        let bd = Infinity;
        cols.forEach((c, k) => {
          const dist = Math.max(0, c.s - t.e, t.s - c.e) * 1000 + Math.abs((c.s + c.e) / 2 - (t.s + t.e) / 2);
          if (dist < bd) {
            bd = dist;
            best = k;
          }
        });
        if (best < 0) continue;
        const side = half > 0 && best >= half ? 'w' : 'b';
        cell[side + cols[best].name] = t.v;
      }
      const bs = cell.bsession;
      const ws = cell.wsession;
      if (!bs || !ws) continue;
      const blocker = get(bs, j);
      const waiter = get(ws, j);
      if (cell.bprocess) setMeta(blocker, '프로세스', cell.bprocess);
      if (cell.wprocess) setMeta(waiter, '프로세스', cell.wprocess);
      if (cell.bserial) setMeta(blocker, 'serial#', cell.bserial);
      if (cell.wserial) setMeta(waiter, 'serial#', cell.wserial);
      const held = oraLock(res, cell.bholds ?? '', j);
      const want = oraLock(res, cell.wwaits ?? '', j);
      blocker.holds.push(held);
      if (cell.bwaits) blocker.waits.push(oraLock(res, cell.bwaits, j));
      if (cell.wholds) waiter.holds.push(oraLock(res, cell.wholds, j));
      waiter.waits.push(want);
      d.edges.push({ from: d.txns.indexOf(waiter), to: d.txns.indexOf(blocker), lock: want });
    }
    // Following sections up to the next report.
    let end = lines.length;
    for (let k = j; k < lines.length; k++) {
      if (/^\s*Deadlock graph:/.test(lines[k]) || (k > j + 2 && /DEADLOCK DETECTED/.test(lines[k]))) {
        end = k;
        break;
      }
    }
    let cur: DlTxn | null = null;
    let inSql = false;
    for (let k = j; k < end; k++) {
      const l = lines[k];
      const t = l.trim();
      let m = t.match(/^Session (\d+): obj - rowid = ([0-9A-Fa-f]+) - (\S+)/);
      if (m) {
        const s = bySid.get(m[1]);
        if (s) {
          const objn = lines[k + 1]?.match(/dictionary objn - (\d+), file - (\d+), block - (\d+), slot - (\d+)/);
          s.waits[0]?.details.push(
            `대기 행 ROWID ${m[3]}` +
              (objn ? ` (object_id ${objn[1]}, file ${objn[2]}, block ${objn[3]}, slot ${objn[4]})` : ''),
          );
          if (objn) s.meta.push(['대기 행 object_id', objn[1]]);
        }
        continue;
      }
      if ((m = t.match(/^Session (\d+): no row/))) {
        const s = bySid.get(m[1]);
        s?.waits[0]?.details.push('특정 행을 기다리지 않음 (no row)');
        s?.waits[0]?.flags.add('gap');
        continue;
      }
      if ((m = t.match(/^Session (\d+):$/))) {
        cur = bySid.get(m[1]) ?? null;
        inSql = false;
        continue;
      }
      if (/^-----/.test(t)) {
        inSql = false;
        if ((m = t.match(/Current SQL Statement for this session/i)) && thisSid) {
          cur = bySid.get(thisSid) ?? null;
          if (cur && !cur.sql) inSql = true;
          else cur = null;
          continue;
        }
        if (/End of information/i.test(t)) cur = null;
        continue;
      }
      if (/^Information for THIS session/i.test(t) && thisSid) {
        cur = bySid.get(thisSid) ?? null;
        continue;
      }
      if (!cur) continue;
      if (inSql) {
        if (!t) {
          if (cur.sql) inSql = false;
          continue;
        }
        cur.sql = cur.sql ? cur.sql + '\n' + t : t;
        if (cur.sqlLine < 0) cur.sqlLine = k;
        continue;
      }
      if ((m = t.match(/^sid: (\d+) ser: (\d+).*?user: \d+\/(\S+)/))) {
        setMeta(cur, 'serial#', m[2]);
        setMeta(cur, 'DB 사용자', m[3]);
      } else if ((m = t.match(/machine: (\S+)\s+program: (.+)$/))) {
        setMeta(cur, '머신', m[1]);
        setMeta(cur, '프로그램', m[2].trim());
      } else if ((m = t.match(/^application name: ([^,]+)/))) {
        setMeta(cur, '애플리케이션', m[1].trim());
      } else if (/^current SQL:/i.test(t)) {
        const rest = t.replace(/^current SQL:\s*/i, '');
        if (rest) {
          cur.sql = rest;
          cur.sqlLine = k;
        }
        inSql = !cur.sql;
      }
    }
    if (thisSid && bySid.has(thisSid)) {
      const v = bySid.get(thisSid)!;
      v.victim = true;
      d.victimNote = `교착을 발견한 세션 ${v.name}의 현재 문장만 롤백되고 ORA-00060이 반환되었습니다. 트랜잭션은 그대로 열려 있으므로, 애플리케이션이 ROLLBACK 후 재시도하지 않으면 상대 세션은 계속 기다립니다.`;
    }
    out.push(d);
    i = Math.max(i, j);
  }
  return out;
}

function setMeta(t: DlTxn, k: string, v: string) {
  const e = t.meta.find(([a]) => a === k);
  if (e) e[1] = v;
  else t.meta.push([k, v]);
}

const ORA_MODE: Record<string, string> = {
  X: 'X (배타)',
  S: 'S (공유)',
  SX: 'SX (공유 행 배타)',
  SS: 'SS (공유 행)',
  SSX: 'SSX (공유 + 공유 행 배타)',
  NONE: '없음',
};

function oraLock(res: string, mode: string, line: number): DlLock {
  const flags = new Set<DlLockFlag>();
  const type = res.slice(0, 2);
  const details: string[] = [];
  let target = res;
  if (type === 'TM') {
    flags.add('table');
    const id = res.split('-')[1];
    if (id) {
      const obj = parseInt(id, 16);
      target = `TM 테이블 락 · object_id ${obj}`;
      details.push(`SELECT owner, object_name FROM dba_objects WHERE object_id = ${obj};`);
    }
  } else if (type === 'TX') {
    target = 'TX 행 락 · ' + res.split('-').slice(1, 3).join('-');
  } else if (type === 'UL') {
    target = 'UL 사용자 락(DBMS_LOCK) · ' + res;
  }
  if (mode === 'X') flags.add('X');
  if (mode === 'S' || mode === 'SS') flags.add('S');
  return { mode: ORA_MODE[mode] ?? (mode || '-'), target, details, line, key: res, flags };
}

function oraHints(d: Deadlock): string[] {
  const h: string[] = [];
  const all = d.txns.flatMap((t) => [...t.holds, ...t.waits]);
  const waits = d.txns.flatMap((t) => t.waits);
  if (all.some((l) => l.flags.has('table'))) {
    h.push(
      'TM(테이블) 락 교착입니다. 대부분 외래키 컬럼에 인덱스가 없어, 부모 행을 UPDATE(PK)/DELETE할 때 자식 테이블 전체가 잠기는 경우입니다. 자식 테이블의 FK 컬럼에 인덱스가 있는지 확인하세요. LOCK TABLE을 직접 쓰는 코드도 확인 대상입니다.',
    );
  }
  const tx = waits.filter((w) => w.key.startsWith('TX'));
  if (tx.length && tx.every((w) => w.flags.has('X'))) {
    h.push(
      'TX 행 락(X) 교착입니다. 두 세션이 서로 잠근 행을 기다립니다. 같은 행들을 수정하는 순서를 통일하세요(예: PK 오름차순으로 SELECT … FOR UPDATE 후 처리).',
    );
  }
  if (tx.some((w) => w.flags.has('S'))) {
    h.push(
      'TX 락을 S 모드로 기다립니다. 일반 행 락이 아니라 ITL 슬롯 부족(블록의 INITRANS), 유니크/PK 키에 같은 값을 동시에 INSERT, 비트맵 인덱스 갱신이 원인일 수 있습니다. "Rows waited on"이 no row이면 이 경우입니다.',
    );
  }
  if (all.some((l) => l.key.startsWith('UL'))) h.push('DBMS_LOCK 사용자 락의 획득 순서가 세션마다 다릅니다.');
  if (!h.length) h.push('세션들이 서로가 잡은 락을 기다리며 순환이 생겼습니다. 아래 대기 관계를 확인하세요.');
  return h;
}
