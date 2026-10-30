// Generates docs/ddl-checks.md (the DDL review check reference on GitHub
// Pages) from the CHECKS catalogue, so the page never drifts from the engine.
//   npm run docs          → writes ../docs/ddl-checks.md
//   test/docs.test.ts     → fails when the committed page is out of date

import { CHECKS } from '../src/ddlrules.ts';

const GROUPS: [prefix: RegExp, title: string, intro: string][] = [
  [/^table\./, '테이블', 'CREATE TABLE 문에 적용됩니다.'],
  [/^column\./, '컬럼', 'CREATE TABLE의 컬럼과 ALTER TABLE … ADD / MODIFY / CHANGE 컬럼에 적용됩니다. `columns` 필터를 쓸 수 있습니다.'],
  [/^(index\.|primaryKey\.|foreignKey\.|check\.)/, '인덱스 · 제약', 'CREATE TABLE 안의 인덱스·제약, ALTER TABLE … ADD INDEX, CREATE INDEX에 적용됩니다.'],
  [/^(name\.|object\.)/, '이름 · 오브젝트', '여러 종류의 이름에 공통으로 적용됩니다.'],
  [/^(statement\.|alter\.)/, '구문 · 운영 위험', 'DROP / TRUNCATE / RENAME 같은 구문과 ALTER TABLE의 운영 위험을 봅니다.'],
];

const ALLOW_MISSING = new Set([
  'table.engine',
  'table.charset',
  'table.collate',
  'table.tablespace',
  'index.name.pattern',
  'index.unique.name.pattern',
  'index.fulltext.name.pattern',
  'foreignKey.name.pattern',
  'check.name.pattern',
  'primaryKey.name.pattern',
]);

function valueKind(check: string, example: unknown): string {
  if (check === 'object.name.pattern') return '{ 오브젝트 종류: 정규식 }';
  if (check.endsWith('.pattern')) return '정규식 문자열';
  if (check === 'column.type.maxLength') return '{ 타입: 최대 길이 }';
  if (check === 'column.suffix.types') return '{ 접미사: [타입 …] }';
  if (check === 'column.type.suffixes') return '{ 타입: [접미사 …] }';
  if (check === 'table.requiredColumns') return '[컬럼명 | { name, type }]';
  if (/\.(maxLength|maxColumns|maxIndexes)$/.test(check)) return '숫자';
  if (Array.isArray(example)) return '목록 (선택)';
  if (example === undefined) return '— (값 없음)';
  return typeof example;
}

function yaml(v: unknown, indent = ''): string {
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (Array.isArray(v)) return `[${v.map((x) => yaml(x)).join(', ')}]`;
  if (v && typeof v === 'object')
    return `{ ${Object.entries(v)
      .map(([k, x]) => `${/\s/.test(k) ? `'${k}'` : k}: ${yaml(x, indent)}`)
      .join(', ')} }`;
  return String(v);
}

export function ddlChecksMarkdown(): string {
  const out: string[] = [
    '---',
    'title: 검사 목록',
    'nav_order: 4',
    '---',
    '',
    '# 검사 목록',
    '{: .no_toc }',
    '',
    '규칙 파일의 `check`에 쓸 수 있는 검사 전체입니다. 이 페이지는 앱의 검사 엔진(`frontend/src/ddlrules.ts`)에서 자동으로 만들어집니다.',
    '',
    '- **값**: `value`에 넣는 형식',
    '- **DB**: 이 DB에서만 동작하는 검사 (표시가 없으면 MySQL · PostgreSQL · Oracle 모두)',
    '- **생략 허용**: `allowMissing: true`를 주면 값(옵션·이름)이 아예 없을 때는 통과',
    '- 이름 정규식(`*.pattern`)에는 `{table}` 자리표시자와 `ignoreCase: true`를 쓸 수 있습니다.',
    '',
    `총 **${Object.keys(CHECKS).length}개** 검사`,
    '',
    '1. TOC',
    '{:toc}',
    '',
  ];
  const used = new Set<string>();
  for (const [re, title, intro] of GROUPS) {
    const checks = Object.entries(CHECKS).filter(([k]) => re.test(k) && !used.has(k));
    if (!checks.length) continue;
    out.push(`## ${title}`, '', intro, '');
    for (const [check, def] of checks) {
      used.add(check);
      out.push(`### \`${check}\``, '', def.desc, '');
      const facts = [`**값** ${valueKind(check, def.example)}`];
      if (def.db) facts.push(`**DB** ${def.db.join(', ')}`);
      if (ALLOW_MISSING.has(check)) facts.push('**생략 허용** 지원');
      out.push(facts.join(' · '), '');
      out.push('```yaml', `- check: ${check}`);
      if (def.example !== undefined) out.push(`  value: ${yaml(def.example)}`);
      out.push('  severity: warning', '```', '');
    }
  }
  const rest = Object.keys(CHECKS).filter((k) => !used.has(k));
  if (rest.length) throw new Error('docs: 분류되지 않은 검사 ' + rest.join(', '));
  return out.join('\n');
}
