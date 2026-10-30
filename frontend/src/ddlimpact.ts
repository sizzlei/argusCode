// Online DDL impact: for each ALTER TABLE / CREATE INDEX, how the database is
// expected to run it (MySQL 8.0 / Aurora MySQL 3: INSTANT · INPLACE · COPY;
// PostgreSQL: table rewrite / lock level; Oracle: online or blocking) and a
// caution when writes are blocked or the table is rebuilt.
//
// The previous column definition (to tell a type change from a comment
// change, or a VARCHAR length change that crosses the 255-byte boundary) is
// taken from the folder's CREATE TABLE when available.
//
// No DOM imports, so it can be unit-tested with plain Node.

import type { Alter, Column, CreateIndex, DdlDialect, Index, Span, Statement, Table } from './ddlparse.ts';

export type ImpactLevel = 'instant' | 'inplace' | 'rebuild' | 'blocking';

export interface ImpactFinding {
  from: number;
  to: number;
  severity: 'warning' | 'info';
  message: string;
  level: ImpactLevel;
}

const LEVEL_RANK: Record<ImpactLevel, number> = { instant: 0, inplace: 1, rebuild: 2, blocking: 3 };
const MY_LABEL: Record<ImpactLevel, string> = {
  instant: 'INSTANT — 메타데이터만 변경',
  inplace: 'INPLACE — DML 허용',
  rebuild: 'INPLACE + 테이블 재구성 — DML 허용, 테이블 크기만큼 시간·디스크 필요',
  blocking: 'COPY 또는 쓰기 차단 — 작업 동안 INSERT/UPDATE/DELETE가 막힙니다',
};
const GEN_LABEL: Record<ImpactLevel, string> = {
  instant: '메타데이터만 변경',
  inplace: '온라인 진행',
  rebuild: '테이블 재작성',
  blocking: '작업 동안 쓰기 차단',
};

const lc = (s: string) => s.toLowerCase();
/** Source text of a span (set per analyzeImpact call). */
let text: (sp: Span) => string = () => '';

/** Looks up the CREATE TABLE before the change (null when unknown). */
export type BeforeLookup = (table: string) => Table | null;

export function analyzeImpact(
  src: string,
  stmts: Statement[],
  dialect: DdlDialect,
  before: BeforeLookup = () => null,
): ImpactFinding[] {
  text = (sp: Span) => src.slice(sp.from, sp.to);
  const out: ImpactFinding[] = [];
  const createdHere = new Set<string>();
  for (const s of stmts) {
    if (s.kind === 'create') createdHere.add(lc(s.name));
    if (s.kind === 'alter') {
      // A table created in the same script is empty: nothing to worry about.
      if (createdHere.has(lc(s.name))) continue;
      const b = before(s.name);
      if (dialect === 'mysql') mysqlAlter(s, b, out);
      else if (dialect === 'postgresql') pgAlter(s, b, out);
      else oracleAlter(s, b, out);
    } else if (s.kind === 'index') {
      if (createdHere.has(lc(s.table))) continue;
      createIndex(s, dialect, out);
    }
  }
  return out;
}

// ---- helpers --------------------------------------------------------------------------

interface Item {
  level: ImpactLevel;
  at: Span;
  text: string;
  /** The level is a guess: the previous definition is unknown. */
  unknown?: boolean;
}

function summarize(a: Alter, items: Item[], out: ImpactFinding[], dialect: DdlDialect, extra: string[] = []) {
  if (!items.length) return;
  const worst = items.reduce((w, i) => (LEVEL_RANK[i.level] > LEVEL_RANK[w] ? i.level : w), 'instant' as ImpactLevel);
  const guessed = items.filter((i) => i.level === worst).every((i) => i.unknown);
  const label = guessed
    ? '확인 필요 — 변경 전 정의를 몰라 판단할 수 없습니다(데이터 타입이 바뀌면 쓰기 차단)'
    : dialect === 'mysql'
      ? MY_LABEL[worst]
      : GEN_LABEL[worst];
  const lines = [`온라인 DDL 예상: ${label}.`];
  if (dialect === 'mysql' && (worst === 'blocking' || worst === 'rebuild'))
    lines.push('시작·끝에 메타데이터 락을 잡으므로, 실행 전에 이 테이블을 쓰는 긴 트랜잭션이 없는지 확인하세요.');
  lines.push(...extra);
  out.push({
    from: a.at.from,
    to: a.at.to,
    severity: worst === 'blocking' ? 'warning' : 'info',
    level: worst,
    message: lines.join(' '),
  });
  for (const i of items)
    if (i.level === 'blocking' || i.level === 'rebuild')
      out.push({
        from: i.at.from,
        to: i.at.to,
        severity: i.level === 'blocking' ? 'warning' : 'info',
        level: i.level,
        message: i.text,
      });
}

const colOf = (b: Table | null, name: string) => b?.columns.find((c) => lc(c.name) === lc(name)) ?? null;

/** Bytes per character of the column (utf8mb4 unless stated otherwise). */
function charBytes(c: Column, table: Table | null): number {
  const cs = lc(c.charset ?? table?.options.charset ?? table?.options['default charset'] ?? 'utf8mb4');
  if (/^(latin1|ascii|binary)/.test(cs)) return 1;
  if (/^(utf8mb3|utf8)$/.test(cs)) return 3;
  if (/^(ucs2|utf16)/.test(cs)) return 2;
  return 4;
}

const sameType = (a: Column, b: Column) =>
  lc(a.type.replace(/\s+/g, '')) === lc(b.type.replace(/\s+/g, '')) && a.unsigned === b.unsigned;

// ---- MySQL 8.0 / Aurora MySQL 3 -------------------------------------------------------

function mysqlAlter(a: Alter, b: Table | null, out: ImpactFinding[]) {
  const items: Item[] = [];
  const extra: string[] = [];
  const hasFulltext = !!b?.indexes.some((i) => i.kind === 'fulltext');
  let algorithm = '';
  let lock = '';

  for (const act of a.actions) {
    switch (act.kind) {
      case 'addColumn': {
        const c = act.column;
        if (c.autoIncrement)
          items.push({
            level: 'blocking',
            at: c.span,
            text: `AUTO_INCREMENT 컬럼 추가(${c.name})는 테이블을 재구성하며 쓰기를 막습니다.`,
          });
        else if (/\bAS\s*\(/i.test(text(c.span)) && /\bSTORED\b/i.test(text(c.span)))
          items.push({
            level: 'blocking',
            at: c.span,
            text: `STORED 생성 컬럼 추가(${c.name})는 테이블을 복사(COPY)합니다.`,
          });
        else if (hasFulltext)
          items.push({
            level: 'rebuild',
            at: c.span,
            text: `FULLTEXT 인덱스가 있는 테이블이라 INSTANT가 안 되고 테이블을 재구성합니다 (${c.name}).`,
          });
        else {
          items.push({ level: 'instant', at: c.span, text: '' });
          if (c.position)
            extra.push(
              `${c.name}: 중간 위치(AFTER/FIRST) 추가의 INSTANT는 MySQL 8.0.29 이상(Aurora MySQL 3.05 이상)에서만 됩니다 — 그 이전 버전은 테이블을 재구성합니다.`,
            );
        }
        break;
      }
      case 'dropColumn':
        items.push({
          level: 'rebuild',
          at: act.at,
          text: `컬럼 삭제(${act.name}): MySQL 8.0.29 이상(Aurora MySQL 3.05 이상)은 INSTANT, 그 이전은 테이블을 재구성합니다.`,
        });
        break;
      case 'renameColumn':
        items.push({ level: 'instant', at: act.at, text: '' });
        break;
      case 'modifyColumn': {
        const c = act.column;
        const prev = colOf(b, act.from ?? c.name);
        if (!prev) {
          items.push({
            level: 'blocking',
            unknown: true,
            at: c.span,
            text: `${c.name}: 변경 전 정의를 폴더의 DDL에서 찾지 못해 정확히 판단할 수 없습니다. 데이터 타입이 바뀌면 COPY(쓰기 차단)입니다.`,
          });
          break;
        }
        items.push(mysqlModify(prev, c, b));
        break;
      }
      case 'addIndex':
        items.push(mysqlAddIndex(act.index, hasFulltext));
        break;
      case 'dropIndex':
        items.push(
          act.name === 'PRIMARY'
            ? { level: 'blocking', at: act.at, text: '기본키만 삭제하면 테이블을 복사(COPY)하고 쓰기를 막습니다.' }
            : { level: 'inplace', at: act.at, text: '' },
        );
        break;
      case 'rename':
        items.push({ level: 'instant', at: act.at, text: '' });
        break;
      case 'option': {
        const k = act.key;
        if (k === 'algorithm') algorithm = act.value;
        else if (k === 'lock') lock = act.value;
        else if (k === 'engine' || k === 'row_format' || k === 'key_block_size')
          items.push({ level: 'rebuild', at: act.at, text: `${k.toUpperCase()} 변경은 테이블을 재구성합니다.` });
        else items.push({ level: k === 'auto_increment' ? 'inplace' : 'instant', at: act.at, text: '' });
        break;
      }
      case 'other':
        if (/^CONVERT\s+TO\s+CHARACTER\s+SET/i.test(act.text))
          items.push({
            level: 'blocking',
            at: act.at,
            text: 'CONVERT TO CHARACTER SET은 테이블을 복사(COPY)하고 쓰기를 막습니다.',
          });
        else if (/^ALTER\s+(COLUMN\s+)?\S+\s+(SET|DROP)\s+DEFAULT/i.test(act.text))
          items.push({ level: 'instant', at: act.at, text: '' });
        else if (/^(FORCE|ENGINE)\b/i.test(act.text))
          items.push({ level: 'rebuild', at: act.at, text: '테이블을 재구성합니다.' });
        break;
    }
  }

  const worst = items.reduce((w, i) => Math.max(w, LEVEL_RANK[i.level]), 0);
  if (algorithm === 'INSTANT' && worst > 0)
    extra.push('ALGORITHM=INSTANT를 지정했지만 INSTANT로 할 수 없는 변경이 있어 오류가 납니다.');
  if (algorithm === 'INPLACE' && worst === 3)
    extra.push('ALGORITHM=INPLACE를 지정했지만 COPY가 필요한 변경이 있어 오류가 납니다.');
  if (lock === 'NONE' && worst === 3)
    extra.push('LOCK=NONE을 지정했지만 쓰기를 막아야 하는 변경이 있어 오류가 납니다.');
  summarize(a, items, out, 'mysql', extra);
}

function mysqlModify(prev: Column, c: Column, b: Table | null): Item {
  const at = c.span;
  if (sameType(prev, c)) {
    if (prev.nullable !== false && c.nullable === false)
      return {
        level: 'rebuild',
        at,
        text: `${c.name}: NULL → NOT NULL은 테이블을 재구성합니다 (기존 NULL 값이 있으면 실패).`,
      };
    if (prev.nullable === false && c.nullable !== false)
      return { level: 'rebuild', at, text: `${c.name}: NOT NULL → NULL은 테이블을 재구성합니다.` };
    if (lc(prev.charset ?? '') !== lc(c.charset ?? '') && c.charset)
      return { level: 'blocking', at, text: `${c.name}: 문자셋 변경은 COPY(쓰기 차단)입니다.` };
    return { level: 'instant', at, text: '' };
  }
  const varchar = (x: Column) => x.base === 'varchar' && x.length != null;
  if (varchar(prev) && varchar(c) && lc(prev.charset ?? '') === lc(c.charset ?? '')) {
    const bytes = charBytes(c, b);
    const p = prev.length! * bytes;
    const n = c.length! * bytes;
    if (n > p && p < 256 === n < 256 && prev.nullable === c.nullable) return { level: 'inplace', at, text: '' };
    if (n > p && p < 256 !== n < 256)
      return {
        level: 'blocking',
        at,
        text: `${c.name}: VARCHAR(${prev.length}) → VARCHAR(${c.length})는 길이 저장 바이트가 1 → 2로 바뀌어(255바이트 경계, 문자당 ${bytes}바이트 기준) COPY(쓰기 차단)입니다.`,
      };
    if (n < p) return { level: 'blocking', at, text: `${c.name}: VARCHAR 길이 축소는 COPY(쓰기 차단)입니다.` };
  }
  return {
    level: 'blocking',
    at,
    text: `${c.name}: 데이터 타입 변경(${prev.type} → ${c.type})은 COPY — 작업 동안 쓰기가 막힙니다.`,
  };
}

function mysqlAddIndex(ix: Index, hasFulltext: boolean): Item {
  const at = ix.def ?? ix.at;
  switch (ix.kind) {
    case 'primary':
      return { level: 'rebuild', at, text: '기본키 추가는 테이블을 재구성합니다.' };
    case 'fulltext':
      return hasFulltext
        ? { level: 'blocking', at, text: 'FULLTEXT 인덱스 추가는 작업 동안 쓰기를 막습니다(LOCK=SHARED).' }
        : {
            level: 'blocking',
            at,
            text: '첫 FULLTEXT 인덱스 추가는 테이블을 재구성하고 쓰기를 막습니다(LOCK=SHARED).',
          };
    case 'spatial':
      return { level: 'blocking', at, text: 'SPATIAL 인덱스 추가는 작업 동안 쓰기를 막습니다(LOCK=SHARED).' };
    case 'foreign':
      return {
        level: 'blocking',
        at,
        text: '외래키 추가는 foreign_key_checks=1이면 COPY(쓰기 차단)입니다. 0이면 INPLACE지만 기존 데이터를 검사하지 않습니다.',
      };
    case 'check':
      return { level: 'blocking', at, text: 'CHECK 제약 추가는 COPY(쓰기 차단)입니다.' };
    default:
      return { level: 'inplace', at, text: '' };
  }
}

// ---- PostgreSQL ------------------------------------------------------------------------

const VOLATILE = /\b(random|clock_timestamp|gen_random_uuid|uuid_generate_v\d|nextval|timeofday)\s*\(/i;

function pgAlter(a: Alter, b: Table | null, out: ImpactFinding[]) {
  const items: Item[] = [];
  for (const act of a.actions) {
    switch (act.kind) {
      case 'addColumn': {
        const c = act.column;
        if (c.hasDefault && VOLATILE.test(c.defaultValue ?? ''))
          items.push({
            level: 'blocking',
            at: c.span,
            text: `${c.name}: 휘발성 기본값(${c.defaultValue})이 있는 컬럼 추가는 테이블 전체를 다시 쓰며 그동안 읽기·쓰기가 모두 막힙니다.`,
          });
        else if (c.autoIncrement)
          items.push({
            level: 'blocking',
            at: c.span,
            text: `${c.name}: IDENTITY/SERIAL 컬럼 추가는 모든 행에 값을 채우느라 테이블을 다시 씁니다.`,
          });
        else items.push({ level: 'instant', at: c.span, text: '' });
        break;
      }
      case 'modifyColumn': {
        const c = act.column;
        const prev = colOf(b, c.name);
        const vc = (x: Column) => x.base === 'varchar' || x.base === 'character varying';
        if (
          prev &&
          vc(prev) &&
          (vc(c) || c.base === 'text') &&
          (c.length == null || (prev.length != null && c.length >= prev.length))
        )
          items.push({ level: 'instant', at: c.span, text: '' });
        else
          items.push({
            level: 'blocking',
            at: c.span,
            text: `${c.name}: 타입 변경${prev ? `(${prev.type} → ${c.type})` : ''}은 테이블을 다시 쓰고 그동안 읽기·쓰기가 모두 막힙니다(ACCESS EXCLUSIVE).`,
          });
        break;
      }
      case 'addIndex': {
        const ix = act.index;
        const at = ix.def ?? ix.at;
        if (ix.kind === 'foreign' || ix.kind === 'check')
          items.push({
            level: 'rebuild',
            at,
            text: `${ix.kind === 'foreign' ? '외래키' : 'CHECK'} 제약 추가는 기존 행을 모두 검사하며 그동안 쓰기가 막힙니다. NOT VALID로 추가한 뒤 VALIDATE CONSTRAINT로 나누면 막히는 시간이 짧습니다.`,
          });
        else if (ix.kind === 'primary' || ix.kind === 'unique')
          items.push({
            level: 'blocking',
            at,
            text: '기본키/UNIQUE 제약 추가는 인덱스를 만드는 동안 쓰기를 막습니다. 큰 테이블은 먼저 CREATE UNIQUE INDEX CONCURRENTLY로 만든 뒤 USING INDEX로 붙이는 방법을 검토하세요.',
          });
        break;
      }
      case 'other':
        if (/\bSET\s+NOT\s+NULL\b/i.test(act.text))
          items.push({
            level: 'rebuild',
            at: act.at,
            text: 'SET NOT NULL은 테이블 전체를 검사하며 그동안 읽기·쓰기가 막힙니다(검증된 CHECK (컬럼 IS NOT NULL) 제약이 있으면 생략, PostgreSQL 12 이상).',
          });
        else if (/\bSET\s+(LOGGED|UNLOGGED|TABLESPACE)\b/i.test(act.text))
          items.push({ level: 'blocking', at: act.at, text: '테이블을 다시 쓰며 그동안 읽기·쓰기가 막힙니다.' });
        else items.push({ level: 'instant', at: act.at, text: '' });
        break;
      default:
        items.push({ level: 'instant', at: 'at' in act ? act.at : a.at, text: '' });
    }
  }
  summarize(a, items, out, 'postgresql', [
    'ALTER TABLE은 짧게라도 ACCESS EXCLUSIVE 락을 잡습니다. 앞선 트랜잭션을 기다리는 동안 뒤의 쿼리도 모두 막히므로 lock_timeout을 짧게 두고 실행하는 것이 안전합니다.',
  ]);
}

// ---- Oracle -------------------------------------------------------------------------------

function oracleAlter(a: Alter, b: Table | null, out: ImpactFinding[]) {
  const items: Item[] = [];
  for (const act of a.actions) {
    switch (act.kind) {
      case 'addColumn':
        items.push({ level: 'instant', at: act.column.span, text: '' });
        break;
      case 'dropColumn':
        items.push({
          level: 'blocking',
          at: act.at,
          text: `컬럼 삭제(${act.name})는 모든 블록을 다시 쓰며 오래 걸리고 그동안 테이블이 잠깁니다. 사용량이 적은 시간에 하거나 SET UNUSED 후 나중에 삭제하는 방법을 검토하세요.`,
        });
        break;
      case 'modifyColumn': {
        const c = act.column;
        const prev = colOf(b, c.name);
        if (prev && prev.nullable !== false && c.nullable === false)
          items.push({
            level: 'rebuild',
            at: c.span,
            text: `${c.name}: NOT NULL 추가는 전체 행을 검사하며 그동안 DML이 막힙니다.`,
          });
        else if (prev && prev.base === c.base && (c.length ?? 0) >= (prev.length ?? 0))
          items.push({ level: 'instant', at: c.span, text: '' });
        else
          items.push({
            level: 'blocking',
            at: c.span,
            text: `${c.name}: ${prev ? `${prev.type} → ${c.type} ` : ''}변경은 기존 데이터를 검사·변환하며 그동안 테이블이 잠길 수 있습니다.`,
          });
        break;
      }
      case 'addIndex': {
        const ix = act.index;
        const at = ix.def ?? ix.at;
        if (ix.kind === 'foreign' || ix.kind === 'check')
          items.push({
            level: 'rebuild',
            at,
            text: '제약 추가는 기존 행을 모두 검사합니다. ENABLE NOVALIDATE로 추가한 뒤 나중에 검증하면 막히는 시간이 짧습니다.',
          });
        else
          items.push({ level: 'blocking', at, text: '기본키/UNIQUE 제약 추가는 인덱스를 만드는 동안 DML을 막습니다.' });
        break;
      }
      default:
        items.push({ level: 'instant', at: 'at' in act ? act.at : a.at, text: '' });
    }
  }
  summarize(a, items, out, 'oracle');
}

// ---- CREATE INDEX -----------------------------------------------------------------------

function createIndex(s: CreateIndex, dialect: DdlDialect, out: ImpactFinding[]) {
  const at = s.index.at;
  const push = (level: ImpactLevel, message: string) =>
    out.push({ from: at.from, to: at.to, severity: level === 'blocking' ? 'warning' : 'info', level, message });
  if (dialect === 'mysql') {
    if (s.index.kind === 'fulltext' || s.index.kind === 'spatial')
      push('blocking', `온라인 DDL 예상: ${MY_LABEL.blocking} (${s.index.kind.toUpperCase()} 인덱스는 LOCK=SHARED)`);
    else
      push(
        'inplace',
        `온라인 DDL 예상: ${MY_LABEL.inplace}. 큰 테이블은 시간이 걸리고, 시작·끝에 메타데이터 락을 잡습니다.`,
      );
  } else if (dialect === 'postgresql') {
    if (s.concurrently)
      push(
        'inplace',
        'CONCURRENTLY — 쓰기를 막지 않습니다. 트랜잭션 블록 안에서는 실행할 수 없고, 실패하면 INVALID 인덱스가 남으니 확인 후 삭제하세요.',
      );
    else push('blocking', 'CONCURRENTLY 없이 만들면 인덱스를 만드는 동안 쓰기(INSERT/UPDATE/DELETE)가 막힙니다.');
  } else {
    if (s.online) push('inplace', 'ONLINE — DML을 막지 않습니다(시작·끝에 짧은 락).');
    else push('blocking', 'ONLINE 없이 만들면 인덱스를 만드는 동안 DML이 막힙니다.');
  }
}
