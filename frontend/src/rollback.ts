// Rollback script generator: turns the DDL of a change (ALTER / CREATE /
// DROP / RENAME / COMMENT ON …) into the statements that undo it, newest
// first. What can't be derived from the statement itself (the previous
// column definition for MODIFY, a dropped index …) is taken from the
// CREATE TABLE of the folder's DDL files; whatever is still unknown is left
// as a commented "확인 필요" line instead of a guess.
//
// No DOM imports, so it can be unit-tested with plain Node.

import { parseDdl } from './ddlparse.ts';
import type { Alter, AlterAction, DdlDialect, Index, Statement, Table } from './ddlparse.ts';
import { isReserved } from './reserved.ts';

/** A parsed DDL file of the folder: the state before the change. */
export interface BeforeFile {
  file: string; // shown in comments (relative path)
  src: string;
  stmts: Statement[];
}

export interface RollbackInput {
  src: string;
  dialect: DdlDialect;
  /** Name of the change script, for the header. */
  source: string;
  /** Line number (1-based) of the first character of src in its document. */
  firstLine?: number;
  before?: BeforeFile[];
  /** Header timestamp (tests pass a fixed one). */
  now?: string;
}

export interface RollbackResult {
  text: string;
  /** Change statements rolled back (including partially). */
  statements: number;
  /** Lines that need a manual check. */
  warnings: number;
  /** Statements that cannot be undone (DROP TABLE without definition, TRUNCATE …). */
  impossible: number;
  /** DML and other statements that were skipped. */
  skipped: number;
}

/** Parses the folder's DDL files once; reuse for several rollbacks. */
export function beforeFile(file: string, src: string, dialect: DdlDialect): BeforeFile {
  return { file, src, stmts: parseDdl(src, dialect) };
}

const posClause = (p: string | null) => (p ? ' ' + p : '');
const optionName = (k: string) =>
  ({ charset: 'DEFAULT CHARSET', collate: 'COLLATE', engine: 'ENGINE', auto_increment: 'AUTO_INCREMENT' })[k] ??
  k.toUpperCase();

const lc = (s: string) => s.toLowerCase();
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

export function buildRollback(input: RollbackInput): RollbackResult {
  const { src, dialect } = input;
  const before = input.before ?? [];
  const first = input.firstLine ?? 1;
  const lineAt = (pos: number) => first + (src.slice(0, pos).match(/\n/g)?.length ?? 0);

  const q = (name: string) => {
    if (!name) return name;
    if (/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(name) && !isReserved(name, dialect)) return name;
    return dialect === 'mysql' ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"';
  };
  const qt = (schema: string | undefined, name: string) => (schema ? q(schema) + '.' + q(name) : q(name));
  const str = (s: string) => "'" + s.replace(/'/g, "''") + "'";

  // ---- the state before the change ---------------------------------------------------
  const findTable = (name: string): { t: Table; f: BeforeFile } | null => {
    let hit: { t: Table; f: BeforeFile } | null = null;
    for (const f of before)
      for (const s of f.stmts) if (s.kind === 'create' && lc(s.name) === lc(name)) hit = { t: s, f };
    return hit;
  };
  const where = (f: BeforeFile, pos: number) => `${f.file}:${(f.src.slice(0, pos).match(/\n/g)?.length ?? 0) + 1}`;
  const colDef = (b: { t: Table; f: BeforeFile }, col: string) => {
    const c = b.t.columns.find((x) => lc(x.name) === lc(col));
    return c ? { c, text: oneLine(b.f.src.slice(c.span.from, c.span.to)), at: where(b.f, c.span.from) } : null;
  };
  const findIndex = (table: string, name: string) => {
    const isPk = /^primary$/i.test(name);
    for (const f of before)
      for (const s of f.stmts) {
        if (s.kind === 'create' && lc(s.name) === lc(table)) {
          const ix = s.indexes.find((i) => (isPk ? i.kind === 'primary' : i.name != null && lc(i.name) === lc(name)));
          if (ix?.def) return { ix, text: oneLine(f.src.slice(ix.def.from, ix.def.to)), at: where(f, ix.def.from) };
        }
        if (s.kind === 'index' && s.index.name && lc(s.index.name) === lc(name))
          return { ix: s.index, create: oneLine(f.src.slice(s.span.from, s.span.to)), at: where(f, s.span.from) };
      }
    return null;
  };
  const findComment = (table: string, column?: string): { text: string | null; at: string } | null => {
    // COMMENT ON in the folder (PostgreSQL / Oracle) wins over inline comments.
    for (const f of before)
      for (const s of f.stmts)
        if (
          s.kind === 'comment' &&
          lc(s.table) === lc(table) &&
          (column ? s.target === 'column' && lc(s.column ?? '') === lc(column) : s.target === 'table')
        )
          return { text: s.text, at: where(f, s.span.from) };
    const b = findTable(table);
    if (!b) return null;
    if (!column) return { text: b.t.comment ?? null, at: where(b.f, b.t.span.from) };
    const c = b.t.columns.find((x) => lc(x.name) === lc(column));
    return c ? { text: c.comment ?? null, at: where(b.f, c.span.from) } : null;
  };

  // ---- output ------------------------------------------------------------------------
  const blocks: string[] = [];
  let warnings = 0;
  let impossible = 0;
  let statements = 0;
  const warn = (lines: string[], msg: string) => {
    warnings++;
    lines.push('-- ⚠ 확인 필요: ' + msg);
  };
  const cannot = (lines: string[], msg: string) => {
    impossible++;
    lines.push('-- ✕ 자동으로 되돌릴 수 없음: ' + msg);
  };

  const stmts = parseDdl(src, dialect);
  // Statements in the text that the DDL parser ignores (DML …).
  const skipped = countStatements(src) - stmts.length;
  const header = (s: Statement, n: number) =>
    `-- [${n}] ${lineAt(s.span.from)}행: ${oneLine(src.slice(s.span.from, s.span.to)).slice(0, 110)}`;

  stmts.forEach((s, i) => {
    const lines = [header(s, i + 1)];
    statements++;
    switch (s.kind) {
      case 'create':
        if (s.temporary)
          lines.push(
            `DROP TEMPORARY TABLE ${qt(s.schema, s.name)};`.replace(
              ' TEMPORARY',
              dialect === 'mysql' ? ' TEMPORARY' : '',
            ),
          );
        else lines.push(`DROP TABLE ${qt(s.schema, s.name)};`);
        if (/\bOR\s+REPLACE\b/i.test(src.slice(s.span.from, s.at.from)))
          warn(lines, 'CREATE OR REPLACE — 기존 테이블이 있었다면 원래 정의로 다시 만들어야 합니다');
        break;
      case 'index': {
        const name = s.index.name ?? '';
        if (!name) {
          cannot(lines, '이름 없는 인덱스 — 실제 이름을 확인해 DROP INDEX 하세요');
          break;
        }
        if (dialect === 'mysql') lines.push(`DROP INDEX ${q(name)} ON ${q(s.table)};`);
        else if (dialect === 'postgresql') lines.push(`DROP INDEX ${s.concurrently ? 'CONCURRENTLY ' : ''}${q(name)};`);
        else lines.push(`DROP INDEX ${q(name)}${s.online ? ' ONLINE' : ''};`);
        break;
      }
      case 'comment': {
        const target = s.target === 'table' ? q(s.table) : `${q(s.table)}.${q(s.column ?? '')}`;
        const prev = findComment(s.table, s.column);
        if (dialect === 'mysql') {
          lines.push(`-- (MySQL은 COMMENT ON이 없습니다)`);
          break;
        }
        if (prev) {
          const v = prev.text == null || prev.text === '' ? (dialect === 'postgresql' ? 'NULL' : "''") : str(prev.text);
          lines.push(`-- 원래 코멘트: ${prev.at}`);
          lines.push(`COMMENT ON ${s.target === 'table' ? 'TABLE' : 'COLUMN'} ${target} IS ${v};`);
        } else {
          warn(lines, '원래 코멘트를 폴더의 DDL에서 찾지 못했습니다');
          lines.push(`-- COMMENT ON ${s.target === 'table' ? 'TABLE' : 'COLUMN'} ${target} IS '<원래 코멘트>';`);
        }
        break;
      }
      case 'drop': {
        const obj = s.object || 'TABLE';
        if (obj === 'TABLE' || obj === 'TEMPORARY TABLE') {
          const b = findTable(s.name);
          if (b) {
            warn(
              lines,
              `테이블 구조만 되돌립니다. 데이터는 백업에서 복구하세요 (원래 정의: ${where(b.f, b.t.span.from)})`,
            );
            lines.push(b.f.src.slice(b.t.span.from, b.t.span.to).trim().replace(/;?$/, ';'));
            for (const f of before)
              for (const x of f.stmts)
                if (
                  (x.kind === 'index' && lc(x.table) === lc(s.name)) ||
                  (x.kind === 'comment' && lc(x.table) === lc(s.name))
                )
                  lines.push(f.src.slice(x.span.from, x.span.to).trim().replace(/;?$/, ';'));
          } else cannot(lines, `DROP TABLE ${s.name} — 원래 정의를 폴더에서 찾지 못했습니다. 백업에서 복구하세요`);
        } else if (obj === 'INDEX') {
          const table = dropIndexTable(src.slice(s.span.from, s.span.to));
          const ix = findIndex(table ?? '', s.name) ?? findIndexAnywhere(s.name);
          if (ix && 'create' in ix && ix.create) {
            lines.push(`-- 원래 정의: ${ix.at}`);
            lines.push(ix.create.replace(/;?$/, ';'));
          } else if (ix && 'text' in ix && table) {
            lines.push(`-- 원래 정의: ${ix.at}`);
            lines.push(`ALTER TABLE ${q(table)} ADD ${ix.text};`);
          } else cannot(lines, `DROP INDEX ${s.name} — 원래 정의를 폴더에서 찾지 못했습니다`);
        } else cannot(lines, `DROP ${obj} ${s.name} — 원래 정의로 다시 만들어야 합니다`);
        break;
      }
      case 'truncate':
        cannot(lines, `TRUNCATE ${s.name} — 데이터는 백업에서 복구해야 합니다`);
        break;
      case 'renameTable': {
        const pairs = renamePairs(src.slice(s.span.from, s.span.to));
        if (!pairs.length) cannot(lines, 'RENAME TABLE 구문을 해석하지 못했습니다');
        else
          lines.push(
            `RENAME TABLE ${pairs
              .reverse()
              .map(([a, b]) => `${q(b)} TO ${q(a)}`)
              .join(', ')};`,
          );
        break;
      }
      case 'object': {
        const text = src.slice(s.span.from, s.span.to);
        if (/\bOR\s+REPLACE\b/i.test(text) || /\bOR\s+ALTER\b/i.test(text)) {
          cannot(lines, `CREATE OR REPLACE ${s.object} ${s.name} — 이전 정의로 다시 만들어야 합니다`);
          break;
        }
        const obj = s.object === 'PACKAGE BODY' ? 'PACKAGE BODY' : s.object;
        if (obj === 'TRIGGER' && dialect === 'postgresql' && s.table)
          lines.push(`DROP TRIGGER ${q(s.name)} ON ${q(s.table)};`);
        else lines.push(`DROP ${obj} ${q(s.name)};`);
        if (dialect === 'postgresql' && (obj === 'FUNCTION' || obj === 'PROCEDURE'))
          warn(lines, '같은 이름의 오버로드가 있으면 인자 타입을 붙이세요: DROP FUNCTION 이름(인자 타입)');
        break;
      }
      case 'alter':
        alterRollback(s, lines);
        break;
    }
    blocks.push(lines.join('\n'));
  });

  function alterRollback(a: Alter, lines: string[]) {
    const renameTo = [...a.actions].reverse().find((x) => x.kind === 'rename') as
      Extract<AlterAction, { kind: 'rename' }> | undefined;
    // After RENAME TO the table goes by its new name.
    const table = qt(a.schema, renameTo ? renameTo.to : a.name);
    const b = findTable(a.name);
    /** Reverse clauses, each with an optional end-of-line note. */
    const clauses: { sql: string; note?: string }[] = [];
    const add = (sql: string, note?: string) => clauses.push({ sql, note });
    const standalone: string[] = [];
    /** Commented placeholders for what could not be derived. */
    const todo: string[] = [];
    let skippedOptions = false;
    let usedBefore = false;
    const prevColumn = (name: string): string | null => {
      if (!b) return null;
      const i = b.t.columns.findIndex((c) => lc(c.name) === lc(name));
      if (i < 0) return null;
      return i === 0 ? 'FIRST' : `AFTER ${q(b.t.columns[i - 1].name)}`;
    };

    for (const act of [...a.actions].reverse()) {
      switch (act.kind) {
        case 'addColumn':
          add(`DROP COLUMN ${q(act.column.name)}`);
          break;
        case 'addIndex':
          dropIndexClause(a.name, act.index, add, standalone, todo);
          break;
        case 'dropColumn': {
          const d = b && colDef(b, act.name);
          if (!d) {
            warn(lines, `DROP COLUMN ${act.name} — 원래 컬럼 정의를 폴더의 DDL에서 찾지 못했습니다`);
            todo.push(`-- ADD COLUMN ${q(act.name)} <원래 정의>`);
            break;
          }
          warnings++;
          const note = `원래 정의 ${d.at} · ⚠ 데이터는 복구되지 않음`;
          if (dialect === 'mysql') add(`ADD COLUMN ${d.text}${posClause(prevColumn(act.name))}`, note);
          else if (dialect === 'oracle') add(`ADD (${d.text})`, note);
          else add(`ADD COLUMN ${d.text}`, note);
          break;
        }
        case 'modifyColumn': {
          const oldName = act.from ?? act.column.name;
          const d = b && colDef(b, oldName);
          if (!d) {
            warn(
              lines,
              `${act.from ? 'CHANGE' : 'MODIFY'} ${oldName} — 변경 전 컬럼 정의를 폴더의 DDL에서 찾지 못했습니다`,
            );
            todo.push(
              dialect === 'mysql'
                ? `-- ${act.from ? `CHANGE COLUMN ${q(act.column.name)}` : 'MODIFY COLUMN'} ${q(oldName)} <원래 정의>`
                : `-- ALTER COLUMN ${q(act.column.name)} TYPE <원래 타입>`,
            );
            break;
          }
          usedBefore = true;
          const note = `변경 전 정의 ${d.at}`;
          if (dialect === 'mysql') {
            add(
              act.from && lc(act.from) !== lc(act.column.name)
                ? `CHANGE COLUMN ${q(act.column.name)} ${d.text}`
                : `MODIFY COLUMN ${d.text}`,
              note,
            );
          } else if (dialect === 'postgresql') {
            add(`ALTER COLUMN ${q(act.column.name)} TYPE ${d.c.type}`, note);
            if (act.column.nullable != null && act.column.nullable !== d.c.nullable)
              add(`ALTER COLUMN ${q(act.column.name)} ${d.c.nullable === false ? 'SET' : 'DROP'} NOT NULL`);
          } else {
            const nn = act.column.nullable != null && act.column.nullable !== d.c.nullable;
            add(
              `MODIFY (${q(act.column.name)} ${d.c.type}${nn ? (d.c.nullable === false ? ' NOT NULL' : ' NULL') : ''})`,
              note,
            );
          }
          break;
        }
        case 'renameColumn':
          add(`RENAME COLUMN ${q(act.to)} TO ${q(act.from)}`);
          break;
        case 'dropIndex': {
          const ix = findIndex(a.name, act.name);
          if (!ix) {
            warn(
              lines,
              `DROP ${act.name === 'PRIMARY' ? 'PRIMARY KEY' : 'INDEX ' + act.name} — 원래 정의를 폴더의 DDL에서 찾지 못했습니다`,
            );
            todo.push(`-- ADD <원래 인덱스 정의 ${act.name}>`);
          } else if ('create' in ix && ix.create) {
            standalone.push(`-- 원래 정의 ${ix.at}`, ix.create.replace(/;?$/, ';'));
          } else if ('text' in ix) {
            add(`ADD ${ix.text}`, `원래 정의 ${ix.at}`);
          }
          break;
        }
        case 'rename':
          // handled below: the table is renamed back last
          break;
        case 'option': {
          if (act.key === 'algorithm' || act.key === 'lock') {
            skippedOptions = true;
            break;
          }
          const prev = b?.t.options[act.key];
          if (prev != null && b) {
            add(
              act.key === 'comment' ? `COMMENT = ${str(prev)}` : `${optionName(act.key)} = ${prev}`,
              `원래 값 ${where(b.f, b.t.span.from)}`,
            );
          } else {
            warn(lines, `테이블 옵션 ${act.key} — 원래 값을 폴더의 DDL에서 찾지 못했습니다`);
            todo.push(`-- ${optionName(act.key)} = <원래 값>`);
          }
          break;
        }
        case 'other': {
          // ALTER [COLUMN] c SET|DROP NOT NULL / SET|DROP DEFAULT (PostgreSQL, MySQL)
          const m = oneLine(act.text).match(
            /^ALTER\s+(?:COLUMN\s+)?([`"]?[\w$]+[`"]?)\s+(SET|DROP)\s+(NOT\s+NULL|DEFAULT)\b(.*)$/i,
          );
          if (m) {
            const col = m[1].replace(/[`"]/g, '');
            const notNull = /NOT/i.test(m[3]);
            const setting = /SET/i.test(m[2]);
            if (notNull) {
              add(`ALTER COLUMN ${q(col)} ${setting ? 'DROP' : 'SET'} NOT NULL`);
              break;
            }
            const d = b && colDef(b, col);
            if (d && d.c.hasDefault && d.c.defaultValue != null)
              add(`ALTER COLUMN ${q(col)} SET DEFAULT ${d.c.defaultValue}`, `원래 기본값 ${d.at}`);
            else if (d) add(`ALTER COLUMN ${q(col)} DROP DEFAULT`, `원래 기본값 없음 ${d.at}`);
            else {
              warn(lines, `${col}의 원래 기본값을 폴더의 DDL에서 찾지 못했습니다`);
              todo.push(`-- ALTER COLUMN ${q(col)} SET DEFAULT <원래 값>  (원래 없었다면 DROP DEFAULT)`);
            }
            break;
          }
          warn(lines, `해석하지 못한 동작 — 직접 되돌리세요: ${oneLine(act.text).slice(0, 80)}`);
          break;
        }
      }
    }

    if (usedBefore) lines.push('-- 변경 전 정의는 폴더의 DDL에서 가져왔습니다. 그 파일이 변경 전 상태인지 확인하세요');
    lines.push(...todo);
    const withNote = (c: { sql: string; note?: string }, sep: string) => c.sql + sep + (c.note ? ' -- ' + c.note : '');
    if (clauses.length) {
      if (dialect === 'oracle' && clauses.length > 1) {
        // Oracle: one action per ALTER TABLE is the safe form.
        for (const c of clauses) lines.push(withNote({ ...c, sql: `ALTER TABLE ${table} ${c.sql}` }, ';'));
      } else if (clauses.length === 1)
        lines.push(withNote({ ...clauses[0], sql: `ALTER TABLE ${table} ${clauses[0].sql}` }, ';'));
      else {
        lines.push(`ALTER TABLE ${table}`);
        clauses.forEach((c, i) => lines.push('    ' + withNote(c, i < clauses.length - 1 ? ',' : ';')));
      }
    }
    lines.push(...standalone);
    if (renameTo) lines.push(`ALTER TABLE ${qt(a.schema, renameTo.to)} RENAME TO ${q(a.name)};`);
    if (skippedOptions) lines.push('-- (원래 문장의 ALGORITHM / LOCK 옵션은 넣지 않았습니다. 필요하면 추가하세요)');
  }

  function dropIndexClause(
    table: string,
    ix: Index,
    add: (sql: string, note?: string) => void,
    standalone: string[],
    todo: string[],
  ) {
    const name = ix.name;
    if (ix.kind === 'primary') {
      if (dialect === 'postgresql') add(`DROP CONSTRAINT ${q(name ?? table + '_pkey')}`);
      else add('DROP PRIMARY KEY');
      return;
    }
    if (!name) {
      warnings++;
      if (dialect === 'mysql' && ix.columns[0] && ix.kind !== 'foreign' && ix.kind !== 'check') {
        add(`DROP INDEX ${q(ix.columns[0])}`, `⚠ 이름 없는 인덱스 — MySQL은 첫 컬럼 이름을 씁니다. SHOW INDEX로 확인`);
        return;
      }
      todo.push(
        `-- ⚠ 확인 필요: 이름 없는 ${ix.kind === 'foreign' ? '외래키' : '제약'} — 실제 이름을 확인해 DROP 하세요`,
      );
      return;
    }
    if (dialect === 'mysql') {
      if (ix.kind === 'foreign') add(`DROP FOREIGN KEY ${q(name)}`);
      else if (ix.kind === 'check') add(`DROP CHECK ${q(name)}`);
      else add(`DROP INDEX ${q(name)}`);
      return;
    }
    if (dialect === 'postgresql' && (ix.kind === 'index' || ix.kind === 'fulltext' || ix.kind === 'spatial')) {
      standalone.push(`DROP INDEX ${q(name)};`);
      return;
    }
    add(`DROP CONSTRAINT ${q(name)}`);
  }

  function findIndexAnywhere(name: string) {
    for (const f of before)
      for (const s of f.stmts)
        if (s.kind === 'create') {
          const ix = s.indexes.find((i) => i.name && lc(i.name) === lc(name));
          if (ix?.def)
            return { ix, text: oneLine(f.src.slice(ix.def.from, ix.def.to)), at: where(f, ix.def.from), table: s.name };
        }
    return null;
  }

  const now =
    input.now ??
    (() => {
      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    })();
  const head = [
    `-- 롤백 스크립트: ${input.source} (${now}, ArgusCode)`,
    '-- 작업 문장을 역순으로 되돌립니다. 실행 전에 내용을 확인하세요.',
  ];
  if (warnings || impossible)
    head.push(`-- ⚠ 확인 필요 ${warnings}곳` + (impossible ? `, ✕ 자동으로 되돌릴 수 없는 문장 ${impossible}개` : ''));
  if (skipped > 0) head.push(`-- (DDL이 아닌 문장 ${skipped}개는 제외했습니다)`);
  const body = blocks.reverse();
  const text = [head.join('\n'), ...body].join('\n\n') + '\n';
  return { text, statements, warnings, impossible, skipped: Math.max(0, skipped) };
}

/** Rough statement count (for the "skipped" note): non-empty pieces between semicolons. */
function countStatements(src: string): number {
  const noComments = src
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return noComments.split(';').filter((p) => p.trim() && !/^\s*(DELIMITER|\/)\s*$/i.test(p)).length;
}

/** "DROP INDEX i ON t" → t (MySQL). */
function dropIndexTable(text: string): string | null {
  const m = text.match(/\bON\s+(?:[`"]?[\w$]+[`"]?\.)?[`"]?([\w$]+)[`"]?/i);
  return m ? m[1] : null;
}

/** "RENAME TABLE a TO b, c TO d" → [[a, b], [c, d]]. */
function renamePairs(text: string): [string, string][] {
  const body = text.replace(/^\s*RENAME\s+TABLE\s+/i, '').replace(/;\s*$/, '');
  const out: [string, string][] = [];
  for (const part of body.split(',')) {
    const m = part.match(/^\s*([`"\w$.]+)\s+TO\s+([`"\w$.]+)\s*$/i);
    if (m) out.push([m[1].replace(/[`"]/g, ''), m[2].replace(/[`"]/g, '')]);
  }
  return out;
}
