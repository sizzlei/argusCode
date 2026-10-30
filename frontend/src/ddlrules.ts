// Rule-based DDL review. A ruleset is a declarative list loaded from the
// user's own YAML file (set in Settings > DDL 검토) — company rules never live
// in the app or its repository. Each rule names a `check` from CHECKS, an
// optional `value`, severity, message and filters:
//
//   version: 1
//   rules:
//     - check: table.comment.required
//       severity: error
//       message: 테이블 코멘트는 필수입니다
//     - check: column.name.pattern
//       value: '^[a-z][a-z0-9_]*$'
//       db: [mysql, postgresql]     # only for these databases
//       tables: '^(?!tmp_)'         # only tables whose name matches
//
// Pure module (no DOM / CodeMirror): unit-tested with Node.

import type { Alter, Column, DdlDialect, Index, ObjectDef, Span, Statement, Table } from './ddlparse.ts';
import { isReserved } from './reserved.ts';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding extends Span {
  severity: Severity;
  message: string;
  check: string;
  id?: string;
}

interface CheckDef {
  /** Korean description (template and README). */
  desc: string;
  /** Example value for the template; undefined = flag-only check. */
  example?: unknown;
  /** Databases where the check makes sense (default: all). */
  db?: DdlDialect[];
}

/** Every check a ruleset can use. */
export const CHECKS: Record<string, CheckDef> = {
  'table.name.pattern': { desc: '테이블 이름 정규식', example: '^[a-z][a-z0-9_]*$' },
  'table.name.maxLength': { desc: '테이블 이름 최대 길이', example: 30 },
  'table.comment.required': { desc: '테이블 코멘트 필수 (MySQL COMMENT=, PG/Oracle COMMENT ON TABLE)' },
  'table.primaryKey.required': { desc: '기본 키 필수' },
  'table.primaryKey.autoIncrement': { desc: '단일 컬럼 PK는 AUTO_INCREMENT / IDENTITY / SERIAL' },
  'table.primaryKey.types': { desc: 'PK 컬럼에 허용하는 타입', example: ['bigint'] },
  'table.requiredColumns': {
    desc: '모든 테이블에 있어야 하는 컬럼 (이름, 선택적으로 타입)',
    example: [{ name: 'created_at', type: 'datetime' }, { name: 'updated_at' }],
  },
  'table.engine': { desc: '허용 스토리지 엔진', example: ['InnoDB'], db: ['mysql'] },
  'table.charset': { desc: '허용 문자셋 (테이블 옵션 필수)', example: ['utf8mb4'], db: ['mysql'] },
  'table.collate': { desc: '허용 콜레이션 (테이블 옵션 필수)', example: ['utf8mb4_0900_ai_ci'], db: ['mysql'] },
  'table.tablespace': {
    desc: '테이블스페이스 필수 (값을 주면 허용 목록)',
    example: ['TS_DATA'],
    db: ['oracle', 'postgresql'],
  },
  'table.foreignKey.forbidden': { desc: '외래 키 금지' },
  'table.maxColumns': { desc: '테이블당 최대 컬럼 수', example: 100 },
  'table.maxIndexes': { desc: '테이블당 최대 인덱스 수 (PK 제외)', example: 10 },
  'column.name.pattern': { desc: '컬럼 이름 정규식', example: '^[a-z][a-z0-9_]*$' },
  'column.name.maxLength': { desc: '컬럼 이름 최대 길이', example: 30 },
  'column.name.forbidden': { desc: '사용 금지 컬럼 이름', example: ['type', 'desc', 'order', 'key'] },
  'column.comment.required': { desc: '컬럼 코멘트 필수 (MySQL COMMENT, PG/Oracle COMMENT ON COLUMN)' },
  'column.type.forbidden': { desc: '사용 금지 타입', example: ['enum', 'set', 'float', 'double'] },
  'column.type.maxLength': { desc: '타입별 최대 길이', example: { varchar: 1000, varchar2: 4000 } },
  'column.nullable.forbidden': { desc: 'NULL 허용 컬럼 금지 (NOT NULL 명시 필요)' },
  'column.notNull.defaultRequired': { desc: 'NOT NULL 컬럼은 DEFAULT 필수 (PK·자동 증가 제외)' },
  'column.charset.forbidden': { desc: '컬럼 단위 CHARACTER SET / COLLATE 지정 금지', db: ['mysql'] },
  'index.name.pattern': { desc: '일반 인덱스 이름 정규식', example: '^idx_' },
  'index.unique.name.pattern': { desc: '유니크 인덱스 이름 정규식', example: '^uk_' },
  'index.maxColumns': { desc: '인덱스당 최대 컬럼 수', example: 5 },
  'index.redundant': { desc: '다른 인덱스(또는 PK)의 앞부분과 같은 중복 인덱스' },
  'index.create.concurrently': { desc: 'CREATE INDEX에 CONCURRENTLY 필수', db: ['postgresql'] },
  'index.create.online': { desc: 'CREATE INDEX에 ONLINE 필수', db: ['oracle'] },
  'name.reserved': {
    desc: '예약어 단독 사용 금지 — 테이블·컬럼·인덱스·오브젝트 이름 (DB별 예약어 내장, value로 단어 추가 가능)',
  },
  'column.onUpdate.forbidden': { desc: 'ON UPDATE CURRENT_TIMESTAMP 등 ON UPDATE 절 금지', db: ['mysql'] },
  'column.suffix.types': {
    desc: '접미사별 허용 타입 (접미사로 끝나는 컬럼은 이 타입만)',
    example: { _yn: ['bool', 'boolean', 'tinyint'], _at: ['datetime'], _de: ['date'], _date: ['date'] },
  },
  'column.type.suffixes': {
    desc: '타입별 필수 접미사 (이 타입 컬럼은 이 접미사로 끝나야 함)',
    example: { datetime: ['_at'], date: ['_de', '_date'], bool: ['_yn'], boolean: ['_yn'] },
  },
  'column.comment.pattern': {
    desc: '코멘트 형식 정규식 (columns로 대상 컬럼 한정, 예: 개인정보 표기)',
    example: '\\[PII(-ENC|-HASH|-MSK)?\\]',
  },
  'column.nullable.explicit': { desc: 'NULL / NOT NULL 명시 필수' },
  'index.fulltext.name.pattern': { desc: 'FULLTEXT 인덱스 이름 정규식', example: '^fdx_{table}_[0-9]{2}$' },
  'foreignKey.name.pattern': { desc: '외래 키 제약명 정규식', example: '^fk_{table}_[0-9]{2}$' },
  'check.name.pattern': { desc: 'CHECK 제약명 정규식', example: '^chk_{table}_[0-9]{2}$' },
  'primaryKey.name.pattern': {
    desc: 'PK 제약명 정규식 (allowMissing: true면 이름 생략 허용)',
    example: '^PK_{table}$',
  },
  'object.name.pattern': {
    desc: '오브젝트 종류별 이름 정규식 (VIEW, MATERIALIZED VIEW, SEQUENCE, TRIGGER, PROCEDURE, FUNCTION, PACKAGE, EVENT, SYNONYM)',
    example: { VIEW: '^vw_', PROCEDURE: '^sp_', FUNCTION: '^fn_' },
  },
  'statement.forbidden': {
    desc: '금지 구문 (DROP TABLE, DROP COLUMN, DROP INDEX, TRUNCATE, RENAME, MODIFY COLUMN, DROP DATABASE)',
    example: ['DROP TABLE', 'TRUNCATE', 'DROP COLUMN'],
  },
  'alter.addColumn.notNullWithoutDefault': { desc: 'ALTER로 NOT NULL 컬럼 추가 시 DEFAULT 필수' },
  'alter.addColumn.position': { desc: 'ADD COLUMN에 AFTER / FIRST 금지 (테이블 재구성 유발)', db: ['mysql'] },
  'alter.algorithmLock': {
    desc: 'ALTER TABLE에 ALGORITHM / LOCK 명시 필수 (값: 허용 ALGORITHM 목록)',
    example: ['INSTANT', 'INPLACE'],
    db: ['mysql'],
  },
};

export interface Rule {
  id?: string;
  check: string;
  value?: unknown;
  severity: Severity;
  message?: string;
  db?: DdlDialect[];
  tables?: RegExp;
  columns?: RegExp;
  regex?: RegExp; // compiled `value` for *.pattern checks (without {table})
  /** Case-insensitive name patterns. */
  ignoreCase?: boolean;
  /** Option / constraint-name checks: an absent value is accepted. */
  allowMissing?: boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rule's pattern, with {table} replaced by the (escaped) table name. */
function rx(r: Rule, table = '', value: unknown = r.value): RegExp {
  const v = String(value);
  if (value === r.value && r.regex && !v.includes('{table}')) return r.regex;
  return new RegExp(v.split('{table}').join(escapeRe(table)), r.ignoreCase ? 'i' : '');
}

export interface Ruleset {
  rules: Rule[];
  errors: string[];
}

const DBS: Record<string, DdlDialect> = {
  mysql: 'mysql',
  aurora: 'mysql',
  mariadb: 'mysql',
  postgresql: 'postgresql',
  postgres: 'postgresql',
  pg: 'postgresql',
  oracle: 'oracle',
};

/** Validates a parsed YAML document. Invalid rules are reported and skipped. */
export function compileRules(doc: unknown): Ruleset {
  const errors: string[] = [];
  const out: Rule[] = [];
  const list = doc && typeof doc === 'object' ? (doc as any).rules : undefined;
  if (list == null) return { rules: [], errors };
  if (!Array.isArray(list)) return { rules: [], errors: ['rules는 목록이어야 합니다'] };
  list.forEach((r: any, i: number) => {
    const where = `규칙 ${i + 1}${r?.id ? ` (${r.id})` : ''}`;
    if (!r || typeof r !== 'object') return errors.push(`${where}: 항목 형식이 잘못되었습니다`);
    if (r.enabled === false) return;
    const check = String(r.check ?? '');
    const def = CHECKS[check];
    if (!def) return errors.push(`${where}: 알 수 없는 check '${check}'`);
    const sev = String(r.severity ?? 'warning').toLowerCase();
    const severity: Severity = sev === 'error' || sev === 'info' ? sev : sev === 'warn' || sev === 'warning' ? 'warning' : 'warning';
    const rule: Rule = { id: r.id ? String(r.id) : undefined, check, value: r.value, severity, message: r.message ? String(r.message) : undefined,
      ignoreCase: r.ignoreCase === true, allowMissing: r.allowMissing === true };
    try {
      if (r.db != null) {
        const dbs = (Array.isArray(r.db) ? r.db : [r.db]).map((d: unknown) => DBS[String(d).toLowerCase()]);
        if (dbs.some((d: unknown) => !d)) throw new Error(`db는 mysql / postgresql / oracle 중에서`);
        rule.db = dbs;
      }
      if (r.tables != null) rule.tables = new RegExp(String(r.tables), 'i');
      if (r.columns != null) rule.columns = new RegExp(String(r.columns), 'i');
      if (check === 'object.name.pattern') {
        if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)) throw new Error('value에 { 오브젝트종류: 정규식 } 형식이 필요합니다');
        for (const v of Object.values(r.value)) rx(rule, 'x', v);
      } else if (check.endsWith('.pattern')) {
        if (typeof r.value !== 'string') throw new Error('value에 정규식 문자열이 필요합니다');
        rule.regex = rx({ ...rule, regex: undefined }, 'x');
      }
      if ((check === 'column.suffix.types' || check === 'column.type.suffixes') &&
          (!r.value || typeof r.value !== 'object' || Array.isArray(r.value) || Object.values(r.value).some((v) => !Array.isArray(v))))
        throw new Error('value에 { 이름: [목록] } 형식이 필요합니다');
      if (/maxLength$|maxColumns$|maxIndexes$/.test(check) && check !== 'column.type.maxLength' && !(Number(r.value) > 0))
        throw new Error('value에 양의 숫자가 필요합니다');
      if (check === 'column.type.maxLength' && (typeof r.value !== 'object' || Array.isArray(r.value) || !r.value))
        throw new Error('value에 { 타입: 최대길이 } 형식이 필요합니다');
      if (['table.primaryKey.types', 'column.name.forbidden', 'column.type.forbidden', 'statement.forbidden'].includes(check) && !Array.isArray(r.value))
        throw new Error('value에 목록이 필요합니다');
      if (check === 'table.requiredColumns' && !Array.isArray(r.value)) throw new Error('value에 컬럼 목록이 필요합니다');
    } catch (e) {
      return errors.push(`${where}: ${(e as Error).message}`);
    }
    out.push(rule);
  });
  return { rules: out, errors };
} // prettier-ignore

// ---- checking -----------------------------------------------------------------------

const lc = (s: string) => s.toLowerCase();
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === true ? [] : [String(v)]);
const inList = (v: string, allowed: string[]) => allowed.some((a) => lc(a) === lc(v));

const DEFAULT_MSG: Record<string, string> = {
  'table.name.pattern': '테이블 이름이 규칙에 맞지 않습니다',
  'table.name.maxLength': '테이블 이름이 너무 깁니다',
  'table.comment.required': '테이블 코멘트가 없습니다',
  'table.primaryKey.required': '기본 키(PK)가 없습니다',
  'table.primaryKey.autoIncrement': 'PK가 자동 증가가 아닙니다',
  'table.primaryKey.types': 'PK 타입이 허용되지 않습니다',
  'table.requiredColumns': '필수 컬럼이 없습니다',
  'table.engine': '스토리지 엔진이 규칙과 다릅니다',
  'table.charset': '테이블 문자셋이 규칙과 다릅니다',
  'table.collate': '테이블 콜레이션이 규칙과 다릅니다',
  'table.tablespace': '테이블스페이스가 규칙과 다릅니다',
  'table.foreignKey.forbidden': '외래 키는 사용하지 않습니다',
  'table.maxColumns': '컬럼 수가 너무 많습니다',
  'table.maxIndexes': '인덱스 수가 너무 많습니다',
  'column.name.pattern': '컬럼 이름이 규칙에 맞지 않습니다',
  'column.name.maxLength': '컬럼 이름이 너무 깁니다',
  'column.name.forbidden': '사용하지 않는 컬럼 이름입니다',
  'column.comment.required': '컬럼 코멘트가 없습니다',
  'column.type.forbidden': '사용하지 않는 타입입니다',
  'column.type.maxLength': '컬럼 길이가 너무 깁니다',
  'column.nullable.forbidden': 'NOT NULL이 아닙니다',
  'column.notNull.defaultRequired': 'NOT NULL 컬럼에 DEFAULT가 없습니다',
  'column.charset.forbidden': '컬럼 단위 문자셋/콜레이션 지정은 하지 않습니다',
  'index.name.pattern': '인덱스 이름이 규칙에 맞지 않습니다',
  'index.unique.name.pattern': '유니크 인덱스 이름이 규칙에 맞지 않습니다',
  'index.maxColumns': '인덱스 컬럼이 너무 많습니다',
  'index.redundant': '중복 인덱스입니다',
  'index.create.concurrently': 'CREATE INDEX CONCURRENTLY로 만들어야 합니다 (쓰기 잠금 방지)',
  'index.create.online': 'CREATE INDEX … ONLINE으로 만들어야 합니다 (DML 잠금 방지)',
  'statement.forbidden': '허용되지 않는 구문입니다',
  'name.reserved': '예약어를 이름으로 단독 사용했습니다',
  'column.onUpdate.forbidden': 'ON UPDATE 절은 사용하지 않습니다',
  'column.suffix.types': '접미사에 맞지 않는 타입입니다',
  'column.type.suffixes': '이 타입의 컬럼은 정해진 접미사로 끝나야 합니다',
  'column.comment.pattern': '컬럼 코멘트 형식이 규칙에 맞지 않습니다',
  'column.nullable.explicit': 'NULL / NOT NULL을 명시하지 않았습니다',
  'index.fulltext.name.pattern': 'FULLTEXT 인덱스 이름이 규칙에 맞지 않습니다',
  'foreignKey.name.pattern': '외래 키 제약명이 규칙에 맞지 않습니다',
  'check.name.pattern': 'CHECK 제약명이 규칙에 맞지 않습니다',
  'primaryKey.name.pattern': 'PK 제약명이 규칙에 맞지 않습니다',
  'object.name.pattern': '오브젝트 이름이 규칙에 맞지 않습니다',
  'alter.addColumn.notNullWithoutDefault': 'NOT NULL 컬럼을 DEFAULT 없이 추가합니다',
  'alter.addColumn.position': 'AFTER / FIRST 위치 지정은 하지 않습니다',
  'alter.algorithmLock': 'ALGORITHM / LOCK을 명시해야 합니다',
};

/** Reviews parsed DDL against the rules. */
export function review(stmts: Statement[], rules: Rule[], db: DdlDialect): Finding[] {
  const out: Finding[] = [];
  const active = rules.filter((r) => (!r.db || r.db.includes(db)) && (!CHECKS[r.check].db || CHECKS[r.check].db!.includes(db)));
  if (!active.length) return out;
  const has = (check: string) => active.filter((r) => r.check === check);

  // COMMENT ON … statements anywhere in the document (PostgreSQL / Oracle)
  const tableComments = new Set<string>();
  const columnComments = new Map<string, string>();
  for (const s of stmts)
    if (s.kind === 'comment' && s.text.trim()) {
      if (s.target === 'table') tableComments.add(lc(s.table));
      else columnComments.set(lc(s.table) + '.' + lc(s.column ?? ''), s.text);
    }
  const commentOf = (c: Column, table: string) =>
    c.comment?.trim() ? c.comment : columnComments.get(lc(table) + '.' + lc(c.name));
  const reserved = (r: Rule, name: string) => isReserved(name, db) || inList(name, list(r.value));

  const report = (r: Rule, at: Span, detail?: string) => {
    const msg = r.message ?? DEFAULT_MSG[r.check];
    out.push({
      from: at.from,
      to: Math.max(at.to, at.from + 1),
      severity: r.severity,
      message: detail ? `${msg} — ${detail}` : msg,
      check: r.check,
      id: r.id,
    });
  };
  const forTable = (r: Rule, name: string) => !r.tables || r.tables.test(name);
  const forColumn = (r: Rule, name: string) => !r.columns || r.columns.test(name);

  let pkNames = new Set<string>();
  const checkColumn = (c: Column, table: string, viaAlter: boolean) => {
    for (const r of active) {
      if (r.check === 'name.reserved' && forTable(r, table) && reserved(r, c.name)) report(r, c.at, c.name);
      if (!r.check.startsWith('column.') || !forTable(r, table) || !forColumn(r, c.name)) continue;
      switch (r.check) {
        case 'column.name.pattern':
          if (!rx(r, table).test(c.name)) report(r, c.at, c.name);
          break;
        case 'column.onUpdate.forbidden':
          if (c.onUpdate) report(r, c.at, `${c.name} ON UPDATE ${c.onUpdate}`);
          break;
        case 'column.suffix.types':
          for (const [suffix, types] of Object.entries(r.value as Record<string, unknown[]>))
            if (lc(c.name).endsWith(lc(suffix)) && !inList(c.base, list(types))) {
              report(r, c.at, `${c.name} ${c.type} — ${suffix}는 ${list(types).join(' / ')}`);
              break;
            }
          break;
        case 'column.type.suffixes': {
          const suffixes = Object.entries(r.value as Record<string, unknown[]>).find(([t]) => lc(t) === c.base)?.[1];
          if (suffixes && !list(suffixes).some((sf) => lc(c.name).endsWith(lc(sf))))
            report(r, c.at, `${c.name} ${c.type} — 접미사 ${list(suffixes).join(' / ')}`);
          break;
        }
        case 'column.comment.pattern': {
          const cm = commentOf(c, table);
          if (!cm || !rx(r, table).test(cm)) report(r, c.at, cm ? `${c.name} '${cm}'` : `${c.name} (코멘트 없음)`);
          break;
        }
        case 'column.nullable.explicit':
          if (c.nullable === null && !c.primaryKey && !c.autoIncrement && !pkNames.has(lc(c.name))) report(r, c.at, c.name);
          break;
        case 'column.name.maxLength':
          if (c.name.length > Number(r.value)) report(r, c.at, `${c.name.length}자 > ${r.value}자`);
          break;
        case 'column.name.forbidden':
          if (inList(c.name, list(r.value))) report(r, c.at, c.name);
          break;
        case 'column.comment.required':
          if (!commentOf(c, table)) report(r, c.at, c.name);
          break;
        case 'column.type.forbidden':
          if (inList(c.base, list(r.value))) report(r, c.at, `${c.name} ${c.type}`);
          break;
        case 'column.type.maxLength': {
          const max = Object.entries(r.value as Record<string, unknown>).find(([k]) => lc(k) === c.base)?.[1];
          if (max != null && c.length != null && c.length > Number(max)) report(r, c.at, `${c.type} > ${max}`);
          break;
        }
        case 'column.nullable.forbidden':
          if (c.nullable !== false && !c.primaryKey && !c.autoIncrement && !pkNames.has(lc(c.name))) report(r, c.at, c.name);
          break;
        case 'column.notNull.defaultRequired':
          // ALTER … ADD has its own check (alter.addColumn.notNullWithoutDefault).
          if (c.nullable === false && !c.hasDefault && !c.primaryKey && !c.autoIncrement && !viaAlter && !pkNames.has(lc(c.name)))
            report(r, c.at, c.name);
          break;
        case 'column.charset.forbidden':
          if (c.charset || c.collate) report(r, c.at, [c.charset, c.collate].filter(Boolean).join(' / '));
          break;
      }
    }
  };

  const NAME_CHECK: Partial<Record<Index['kind'], string>> = {
    index: 'index.name.pattern',
    unique: 'index.unique.name.pattern',
    fulltext: 'index.fulltext.name.pattern',
    foreign: 'foreignKey.name.pattern',
    check: 'check.name.pattern',
    primary: 'primaryKey.name.pattern',
  };
  const checkIndex = (ix: Index, table: string) => {
    for (const r of active) {
      if (!forTable(r, table)) continue;
      if (r.check === NAME_CHECK[ix.kind]) {
        // MySQL always names the primary key PRIMARY.
        if (ix.kind === 'primary' && db === 'mysql') continue;
        if (!ix.name) {
          if (!r.allowMissing) report(r, ix.at, '이름 미지정 (자동 생성 이름)');
        } else if (!rx(r, table).test(ix.name)) report(r, ix.at, ix.name);
      }
      if (r.check === 'name.reserved' && ix.name && reserved(r, ix.name)) report(r, ix.at, ix.name);
      if (r.check === 'index.maxColumns' && ix.kind !== 'primary' && ix.kind !== 'check' && ix.columns.length > Number(r.value))
        report(r, ix.at, `${ix.columns.length}개 > ${r.value}개`);
    }
  };

  const objectStatement = (o: ObjectDef) => {
    for (const r of active) {
      if (r.check === 'name.reserved' && reserved(r, o.name)) report(r, o.at, o.name);
      if (r.check !== 'object.name.pattern') continue;
      const pat = Object.entries(r.value as Record<string, unknown>).find(([k]) => k.toUpperCase().replace(/\s+/g, ' ') === o.object)?.[1];
      if (pat != null && !rx(r, o.table ?? '', pat).test(o.name)) report(r, o.at, `${o.object} ${o.name}`);
    }
  };

  const tableStatement = (t: Table) => {
    const pk = t.indexes.find((i) => i.kind === 'primary');
    const pkCols = pk ? t.columns.filter((c) => pk.columns.includes(lc(c.name))) : [];
    for (const r of active) {
      if (!forTable(r, t.name)) continue;
      switch (r.check) {
        case 'table.name.pattern':
          if (!rx(r, t.name).test(t.name)) report(r, t.at, t.name);
          break;
        case 'name.reserved':
          if (reserved(r, t.name)) report(r, t.at, t.name);
          break;
        case 'table.name.maxLength':
          if (t.name.length > Number(r.value)) report(r, t.at, `${t.name.length}자 > ${r.value}자`);
          break;
        case 'table.comment.required':
          if (!t.comment?.trim() && !tableComments.has(lc(t.name))) report(r, t.at, t.name);
          break;
        case 'table.primaryKey.required':
          if (!pk) report(r, t.at, t.name);
          break;
        case 'table.primaryKey.autoIncrement':
          if (pkCols.length === 1 && !pkCols[0].autoIncrement) report(r, pkCols[0].at, pkCols[0].name);
          break;
        case 'table.primaryKey.types':
          for (const c of pkCols) if (!inList(c.base, list(r.value))) report(r, c.at, `${c.name} ${c.type}`);
          break;
        case 'table.requiredColumns':
          for (const req of r.value as unknown[]) {
            const name = typeof req === 'string' ? req : String((req as any)?.name ?? '');
            const type = typeof req === 'object' && req ? (req as any).type : undefined;
            const col = t.columns.find((c) => lc(c.name) === lc(name));
            if (!col) report(r, t.at, `${name} 없음`);
            else if (type && !inList(col.base, list(type)))
              report(r, col.at, `${name}은(는) ${list(type).join(' / ')} 타입이어야 합니다 (현재 ${col.type})`);
          }
          break;
        case 'table.engine':
        case 'table.charset':
        case 'table.collate':
        case 'table.tablespace': {
          const key = r.check.slice(6);
          const v = t.options[key];
          const allowed = list(r.value);
          if (t.temporary && key !== 'tablespace') break;
          if (!v) {
            if (!r.allowMissing) report(r, t.at, `${key.toUpperCase()} 지정 없음`);
          }
          else if (allowed.length && !inList(v, allowed)) report(r, t.at, `${v} (허용: ${allowed.join(', ')})`);
          break;
        }
        case 'table.foreignKey.forbidden':
          for (const ix of t.indexes) if (ix.kind === 'foreign') report(r, ix.at, ix.name ?? 'FOREIGN KEY');
          break;
        case 'table.maxColumns':
          if (t.columns.length > Number(r.value)) report(r, t.at, `${t.columns.length}개 > ${r.value}개`);
          break;
        case 'table.maxIndexes': {
          const n = t.indexes.filter((i) => i.kind !== 'primary' && i.kind !== 'foreign' && i.kind !== 'check').length;
          if (n > Number(r.value)) report(r, t.at, `${n}개 > ${r.value}개`);
          break;
        }
        case 'index.redundant':
          for (const f of redundant(t.indexes)) report(r, f.ix.at, f.detail);
          break;
      }
    }
    pkNames = new Set(pk?.columns ?? []);
    for (const c of t.columns) checkColumn(c, t.name, false);
    pkNames = new Set();
    for (const ix of t.indexes) checkIndex(ix, t.name);
  };

  const alterStatement = (a: Alter) => {
    const algo = a.actions.find((x) => x.kind === 'option' && x.key === 'algorithm');
    const lock = a.actions.find((x) => x.kind === 'option' && x.key === 'lock');
    for (const r of active) {
      if (!forTable(r, a.name)) continue;
      if (r.check === 'alter.algorithmLock') {
        const allowed = list(r.value);
        if (!algo || !lock) report(r, a.at, [!algo && 'ALGORITHM', !lock && 'LOCK'].filter(Boolean).join(', ') + ' 없음');
        else if (algo.kind === 'option' && allowed.length && !inList(algo.value, allowed)) report(r, algo.at, `ALGORITHM=${algo.value} (허용: ${allowed.join(', ')})`);
      }
      for (const act of a.actions) {
        if (act.kind !== 'addColumn') continue;
        const c = act.column;
        if (r.check === 'alter.addColumn.notNullWithoutDefault' && c.nullable === false && !c.hasDefault && !c.autoIncrement) report(r, c.at, c.name);
        if (r.check === 'alter.addColumn.position' && c.position) report(r, c.at, `${c.name} ${c.position === 'first' ? 'FIRST' : 'AFTER'}`);
      }
      if (r.check === 'statement.forbidden') {
        const banned = list(r.value).map((v) => v.toUpperCase().replace(/\s+/g, ' '));
        for (const act of a.actions) {
          const kw = act.kind === 'dropColumn' ? 'DROP COLUMN' : act.kind === 'dropIndex' ? 'DROP INDEX' : act.kind === 'modifyColumn' ? 'MODIFY COLUMN' : act.kind === 'rename' || act.kind === 'renameColumn' ? 'RENAME' : '';
          if (!kw || !banned.includes(kw)) continue;
          report(r, act.kind === 'modifyColumn' ? act.column.at : 'at' in act ? act.at : a.at, kw);
        }
      }
    }
    for (const act of a.actions) {
      if (act.kind === 'addColumn' || act.kind === 'modifyColumn') checkColumn(act.column, a.name, true);
      if (act.kind === 'addIndex') checkIndex(act.index, a.name);
    }
  };

  for (const s of stmts) {
    if (s.kind === 'object') objectStatement(s);
    else if (s.kind === 'create') tableStatement(s);
    else if (s.kind === 'alter') alterStatement(s);
    else if (s.kind === 'index') {
      checkIndex(s.index, s.table);
      for (const r of has('index.create.concurrently')) if (forTable(r, s.table) && !s.concurrently) report(r, s.index.at, s.index.name ?? '');
      for (const r of has('index.create.online')) if (forTable(r, s.table) && !s.online) report(r, s.index.at, s.index.name ?? '');
    } else if (s.kind === 'drop' || s.kind === 'truncate' || s.kind === 'renameTable') {
      const kw = s.kind === 'truncate' ? 'TRUNCATE' : s.kind === 'renameTable' ? 'RENAME' : `DROP ${s.object}`.trim();
      for (const r of has('statement.forbidden')) {
        const banned = list(r.value).map((v) => v.toUpperCase().replace(/\s+/g, ' '));
        if (banned.includes(kw) || (kw.startsWith('DROP') && banned.includes('DROP'))) report(r, s.span, kw + (s.name ? ' ' + s.name : ''));
      }
    }
  }
  return out.sort((a, b) => a.from - b.from);
} // prettier-ignore

/** Indexes whose column list is a leading prefix of another index (or equal to it). */
function redundant(indexes: Index[]): { ix: Index; detail: string }[] {
  const out: { ix: Index; detail: string }[] = [];
  const cand = indexes.filter(
    (i) => i.kind !== 'foreign' && i.kind !== 'fulltext' && i.kind !== 'spatial' && i.columns.length,
  );
  for (const a of cand) {
    if (a.kind === 'primary' || a.kind === 'unique') continue; // unique constraints carry meaning
    const cover = cand.find(
      (b) =>
        b !== a &&
        b.columns.length >= a.columns.length &&
        a.columns.every((c, i) => b.columns[i] === c) &&
        (b.columns.length > a.columns.length || b.kind !== 'index' || cand.indexOf(b) < cand.indexOf(a)),
    );
    if (cover)
      out.push({
        ix: a,
        detail: `${a.name ?? '(' + a.columns.join(', ') + ')'} ⊂ ${cover.kind === 'primary' ? 'PRIMARY KEY' : (cover.name ?? '(' + cover.columns.join(', ') + ')')}`,
      });
  }
  return out;
}

/** The starter file written by Settings > DDL 검토 > 템플릿 만들기. */
export function templateYaml(): string {
  const lines = [
    '# ArgusCode DDL 검토 규칙',
    '#',
    '# 이 파일은 회사·팀 규칙을 담는 곳입니다. 앱이나 공개 저장소에 넣지 말고',
    '# 팀 공용 폴더나 사내 저장소에 두고 설정 > DDL 검토에서 경로를 지정하세요.',
    '#',
    '# 규칙 형식',
    '#   - check:    검사 이름 (아래 목록)',
    '#     value:    검사에 필요한 값 (정규식, 숫자, 목록 …)',
    '#     severity: error | warning | info   (기본 warning)',
    '#     message:  표시할 문구 (생략하면 기본 문구)',
    '#     id:       규칙 번호 (예: DDL-001) — 메시지에 함께 표시',
    '#     db:       [mysql, postgresql, oracle] 중 적용할 DB (생략하면 전체)',
    "#     tables:   이 정규식에 맞는 테이블에만 적용 (예: '^(?!tmp_|bak_)')",
    '#     columns:  컬럼 검사를 이 정규식에 맞는 컬럼에만 적용',
    '#     enabled:  false 로 두면 끔',
    '#',
    '# SQL 방언은 상태 표시줄 / 설정의 SQL 방언을 따릅니다.',
    '# 사용하려는 규칙의 주석(#)을 지우고 값을 회사 기준으로 바꾸세요.',
    '',
    'version: 1',
    'rules:',
  ];
  for (const [check, def] of Object.entries(CHECKS)) {
    lines.push('', `  # ${def.desc}${def.db ? ` (${def.db.join(', ')})` : ''}`);
    lines.push(`  # - check: ${check}`);
    if (def.example !== undefined) lines.push(`  #   value: ${yamlInline(def.example)}`);
    lines.push('  #   severity: warning');
  }
  lines.push('');
  return lines.join('\n');
}

function yamlInline(v: unknown): string {
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (Array.isArray(v)) return `[${v.map(yamlInline).join(', ')}]`;
  if (v && typeof v === 'object')
    return `{ ${Object.entries(v)
      .map(([k, x]) => `${k}: ${yamlInline(x)}`)
      .join(', ')} }`;
  return String(v);
}
