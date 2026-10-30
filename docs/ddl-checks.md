---
title: 검사 목록
nav_order: 4
---

# 검사 목록
{: .no_toc }

규칙 파일의 `check`에 쓸 수 있는 검사 전체입니다. 이 페이지는 앱의 검사 엔진(`frontend/src/ddlrules.ts`)에서 자동으로 만들어집니다.

- **값**: `value`에 넣는 형식
- **DB**: 이 DB에서만 동작하는 검사 (표시가 없으면 MySQL · PostgreSQL · Oracle 모두)
- **생략 허용**: `allowMissing: true`를 주면 값(옵션·이름)이 아예 없을 때는 통과
- 이름 정규식(`*.pattern`)에는 `{table}` 자리표시자와 `ignoreCase: true`를 쓸 수 있습니다.

총 **44개** 검사

1. TOC
{:toc}

## 테이블

CREATE TABLE 문에 적용됩니다.

### `table.name.pattern`

테이블 이름 정규식

**값** 정규식 문자열

```yaml
- check: table.name.pattern
  value: '^[a-z][a-z0-9_]*$'
  severity: warning
```

### `table.name.maxLength`

테이블 이름 최대 길이

**값** 숫자

```yaml
- check: table.name.maxLength
  value: 30
  severity: warning
```

### `table.comment.required`

테이블 코멘트 필수 (MySQL COMMENT=, PG/Oracle COMMENT ON TABLE)

**값** — (값 없음)

```yaml
- check: table.comment.required
  severity: warning
```

### `table.primaryKey.required`

기본 키 필수

**값** — (값 없음)

```yaml
- check: table.primaryKey.required
  severity: warning
```

### `table.primaryKey.autoIncrement`

단일 컬럼 PK는 AUTO_INCREMENT / IDENTITY / SERIAL

**값** — (값 없음)

```yaml
- check: table.primaryKey.autoIncrement
  severity: warning
```

### `table.primaryKey.types`

PK 컬럼에 허용하는 타입

**값** 목록 (선택)

```yaml
- check: table.primaryKey.types
  value: ['bigint']
  severity: warning
```

### `table.requiredColumns`

모든 테이블에 있어야 하는 컬럼 (이름, 선택적으로 타입)

**값** [컬럼명 | { name, type }]

```yaml
- check: table.requiredColumns
  value: [{ name: 'created_at', type: 'datetime' }, { name: 'updated_at' }]
  severity: warning
```

### `table.engine`

허용 스토리지 엔진

**값** 목록 (선택) · **DB** mysql · **생략 허용** 지원

```yaml
- check: table.engine
  value: ['InnoDB']
  severity: warning
```

### `table.charset`

허용 문자셋 (테이블 옵션 필수)

**값** 목록 (선택) · **DB** mysql · **생략 허용** 지원

```yaml
- check: table.charset
  value: ['utf8mb4']
  severity: warning
```

### `table.collate`

허용 콜레이션 (테이블 옵션 필수)

**값** 목록 (선택) · **DB** mysql · **생략 허용** 지원

```yaml
- check: table.collate
  value: ['utf8mb4_0900_ai_ci']
  severity: warning
```

### `table.tablespace`

테이블스페이스 필수 (값을 주면 허용 목록)

**값** 목록 (선택) · **DB** oracle, postgresql · **생략 허용** 지원

```yaml
- check: table.tablespace
  value: ['TS_DATA']
  severity: warning
```

### `table.foreignKey.forbidden`

외래 키 금지

**값** — (값 없음)

```yaml
- check: table.foreignKey.forbidden
  severity: warning
```

### `table.maxColumns`

테이블당 최대 컬럼 수

**값** 숫자

```yaml
- check: table.maxColumns
  value: 100
  severity: warning
```

### `table.maxIndexes`

테이블당 최대 인덱스 수 (PK 제외)

**값** 숫자

```yaml
- check: table.maxIndexes
  value: 10
  severity: warning
```

## 컬럼

CREATE TABLE의 컬럼과 ALTER TABLE … ADD / MODIFY / CHANGE 컬럼에 적용됩니다. `columns` 필터를 쓸 수 있습니다.

### `column.name.pattern`

컬럼 이름 정규식

**값** 정규식 문자열

```yaml
- check: column.name.pattern
  value: '^[a-z][a-z0-9_]*$'
  severity: warning
```

### `column.name.maxLength`

컬럼 이름 최대 길이

**값** 숫자

```yaml
- check: column.name.maxLength
  value: 30
  severity: warning
```

### `column.name.forbidden`

사용 금지 컬럼 이름

**값** 목록 (선택)

```yaml
- check: column.name.forbidden
  value: ['type', 'desc', 'order', 'key']
  severity: warning
```

### `column.comment.required`

컬럼 코멘트 필수 (MySQL COMMENT, PG/Oracle COMMENT ON COLUMN)

**값** — (값 없음)

```yaml
- check: column.comment.required
  severity: warning
```

### `column.type.forbidden`

사용 금지 타입

**값** 목록 (선택)

```yaml
- check: column.type.forbidden
  value: ['enum', 'set', 'float', 'double']
  severity: warning
```

### `column.type.maxLength`

타입별 최대 길이

**값** { 타입: 최대 길이 }

```yaml
- check: column.type.maxLength
  value: { varchar: 1000, varchar2: 4000 }
  severity: warning
```

### `column.nullable.forbidden`

NULL 허용 컬럼 금지 (NOT NULL 명시 필요)

**값** — (값 없음)

```yaml
- check: column.nullable.forbidden
  severity: warning
```

### `column.notNull.defaultRequired`

NOT NULL 컬럼은 DEFAULT 필수 (PK·자동 증가 제외)

**값** — (값 없음)

```yaml
- check: column.notNull.defaultRequired
  severity: warning
```

### `column.charset.forbidden`

컬럼 단위 CHARACTER SET / COLLATE 지정 금지

**값** — (값 없음) · **DB** mysql

```yaml
- check: column.charset.forbidden
  severity: warning
```

### `column.onUpdate.forbidden`

ON UPDATE CURRENT_TIMESTAMP 등 ON UPDATE 절 금지

**값** — (값 없음) · **DB** mysql

```yaml
- check: column.onUpdate.forbidden
  severity: warning
```

### `column.suffix.types`

접미사별 허용 타입 (접미사로 끝나는 컬럼은 이 타입만)

**값** { 접미사: [타입 …] }

```yaml
- check: column.suffix.types
  value: { _yn: ['bool', 'boolean', 'tinyint'], _at: ['datetime'], _de: ['date'], _date: ['date'] }
  severity: warning
```

### `column.type.suffixes`

타입별 필수 접미사 (이 타입 컬럼은 이 접미사로 끝나야 함)

**값** { 타입: [접미사 …] }

```yaml
- check: column.type.suffixes
  value: { datetime: ['_at'], date: ['_de', '_date'], bool: ['_yn'], boolean: ['_yn'] }
  severity: warning
```

### `column.comment.pattern`

코멘트 형식 정규식 (columns로 대상 컬럼 한정, 예: 개인정보 표기)

**값** 정규식 문자열

```yaml
- check: column.comment.pattern
  value: '\[PII(-ENC|-HASH|-MSK)?\]'
  severity: warning
```

### `column.nullable.explicit`

NULL / NOT NULL 명시 필수

**값** — (값 없음)

```yaml
- check: column.nullable.explicit
  severity: warning
```

## 인덱스 · 제약

CREATE TABLE 안의 인덱스·제약, ALTER TABLE … ADD INDEX, CREATE INDEX에 적용됩니다.

### `index.name.pattern`

일반 인덱스 이름 정규식

**값** 정규식 문자열 · **생략 허용** 지원

```yaml
- check: index.name.pattern
  value: '^idx_'
  severity: warning
```

### `index.unique.name.pattern`

유니크 인덱스 이름 정규식

**값** 정규식 문자열 · **생략 허용** 지원

```yaml
- check: index.unique.name.pattern
  value: '^uk_'
  severity: warning
```

### `index.maxColumns`

인덱스당 최대 컬럼 수

**값** 숫자

```yaml
- check: index.maxColumns
  value: 5
  severity: warning
```

### `index.redundant`

다른 인덱스(또는 PK)의 앞부분과 같은 중복 인덱스

**값** — (값 없음)

```yaml
- check: index.redundant
  severity: warning
```

### `index.create.concurrently`

CREATE INDEX에 CONCURRENTLY 필수

**값** — (값 없음) · **DB** postgresql

```yaml
- check: index.create.concurrently
  severity: warning
```

### `index.create.online`

CREATE INDEX에 ONLINE 필수

**값** — (값 없음) · **DB** oracle

```yaml
- check: index.create.online
  severity: warning
```

### `index.fulltext.name.pattern`

FULLTEXT 인덱스 이름 정규식

**값** 정규식 문자열 · **생략 허용** 지원

```yaml
- check: index.fulltext.name.pattern
  value: '^fdx_{table}_[0-9]{2}$'
  severity: warning
```

### `foreignKey.name.pattern`

외래 키 제약명 정규식

**값** 정규식 문자열 · **생략 허용** 지원

```yaml
- check: foreignKey.name.pattern
  value: '^fk_{table}_[0-9]{2}$'
  severity: warning
```

### `check.name.pattern`

CHECK 제약명 정규식

**값** 정규식 문자열 · **생략 허용** 지원

```yaml
- check: check.name.pattern
  value: '^chk_{table}_[0-9]{2}$'
  severity: warning
```

### `primaryKey.name.pattern`

PK 제약명 정규식 (allowMissing: true면 이름 생략 허용)

**값** 정규식 문자열 · **생략 허용** 지원

```yaml
- check: primaryKey.name.pattern
  value: '^PK_{table}$'
  severity: warning
```

## 이름 · 오브젝트

여러 종류의 이름에 공통으로 적용됩니다.

### `name.reserved`

예약어 단독 사용 금지 — 테이블·컬럼·인덱스·오브젝트 이름 (DB별 예약어 내장, value로 단어 추가 가능)

**값** — (값 없음)

```yaml
- check: name.reserved
  severity: warning
```

### `object.name.pattern`

오브젝트 종류별 이름 정규식 (VIEW, MATERIALIZED VIEW, SEQUENCE, TRIGGER, PROCEDURE, FUNCTION, PACKAGE, EVENT, SYNONYM)

**값** { 오브젝트 종류: 정규식 }

```yaml
- check: object.name.pattern
  value: { VIEW: '^vw_', PROCEDURE: '^sp_', FUNCTION: '^fn_' }
  severity: warning
```

## 구문 · 운영 위험

DROP / TRUNCATE / RENAME 같은 구문과 ALTER TABLE의 운영 위험을 봅니다.

### `statement.forbidden`

금지 구문 (DROP TABLE, DROP COLUMN, DROP INDEX, TRUNCATE, RENAME, MODIFY COLUMN, DROP DATABASE)

**값** 목록 (선택)

```yaml
- check: statement.forbidden
  value: ['DROP TABLE', 'TRUNCATE', 'DROP COLUMN']
  severity: warning
```

### `alter.addColumn.notNullWithoutDefault`

ALTER로 NOT NULL 컬럼 추가 시 DEFAULT 필수

**값** — (값 없음)

```yaml
- check: alter.addColumn.notNullWithoutDefault
  severity: warning
```

### `alter.addColumn.position`

ADD COLUMN에 AFTER / FIRST 금지 (테이블 재구성 유발)

**값** — (값 없음) · **DB** mysql

```yaml
- check: alter.addColumn.position
  severity: warning
```

### `alter.algorithmLock`

ALTER TABLE에 ALGORITHM / LOCK 명시 필수 (값: 허용 ALGORITHM 목록)

**값** 목록 (선택) · **DB** mysql

```yaml
- check: alter.algorithmLock
  value: ['INSTANT', 'INPLACE']
  severity: warning
```
