---
title: 규칙 작성 가이드
nav_order: 3
---

# 규칙 작성 가이드
{: .no_toc }

팀의 DDL 설계 기준을 ArgusCode가 읽을 수 있는 규칙 파일(YAML)로 옮기는 방법입니다.
{: .fs-5 .fw-300 }

1. TOC
{:toc}

---

이 페이지의 예시 규칙 몇 개를 적용하면 이렇게 보입니다. 패널의 `R-01` 같은 번호가 규칙의 `id`이고, 메시지는 `message`(또는 기본 문구)입니다.

![규칙을 적용한 DDL 검토 결과](assets/screenshots/ddl-review.png)

## 기본 형태

```yaml
version: 1
rules:
  - id: DDL-01                      # 규칙 번호 (선택) — 메시지 앞에 [DDL-01]로 표시
    check: table.comment.required   # 검사 이름 (필수) — 검사 목록 참고
    severity: error                 # error | warning | info  (기본 warning)
    message: 테이블 코멘트는 필수입니다  # 표시할 문구 (선택, 생략하면 기본 문구)

  - check: column.name.pattern
    value: '^[a-z][a-z0-9_]*$'      # 검사에 필요한 값
    db: [mysql, postgresql]         # 적용할 DB (선택, 생략하면 전체)
```

- `rules` 아래에 규칙을 원하는 만큼 나열합니다. 같은 검사를 값·DB·대상을 달리해 여러 번 써도 됩니다.
- 위반을 찾으면 `메시지 — 상세` 형태로 보여줍니다. 상세에는 대상 이름이나 실제 값이 들어갑니다. 예: `테이블 코멘트는 필수입니다 — orders`.
- 쓸 수 있는 검사와 값 형식은 [검사 목록](ddl-checks.html)에 모두 있습니다.

## 규칙 필드

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `check` | ● | 검사 이름. [검사 목록](ddl-checks.html) 참고 |
| `value` | 검사에 따라 | 정규식, 숫자, 목록, 매핑 등 검사마다 정해진 형식 |
| `severity` | | `error` · `warning` · `info`. 기본 `warning` |
| `message` | | 표시할 문구. 근거 문서·조항을 넣어 두면 리뷰할 때 편합니다 |
| `id` | | 규칙 번호. 패널과 Markdown 복사 결과에 함께 표시 |
| `db` | | `[mysql, postgresql, oracle]` 중 적용할 DB. `aurora`, `mariadb`는 mysql로, `postgres`, `pg`는 postgresql로 인식 |
| `tables` | | 이 정규식에 맞는 **테이블**에만 적용 (대소문자 무시) |
| `columns` | | 이 정규식에 맞는 **컬럼**에만 적용 (`column.*` 검사, 대소문자 무시) |
| `ignoreCase` | | `true`면 이름 정규식(`*.pattern`)을 대소문자 무시로 비교 |
| `allowMissing` | | `true`면 값이 아예 없을 때는 통과 (테이블 옵션, 제약·인덱스 이름) |
| `enabled` | | `false`면 규칙을 끔 (지우지 않고 잠시 끌 때) |

## 심각도 정하기

| 심각도 | 표시 | 권장 용도 |
| --- | --- | --- |
| `error` | ✕ 빨강 | 위반하면 배포·설계 검토를 통과할 수 없는 **강제 항목** |
| `warning` | ⚠ 노랑 | 지키는 것이 원칙인 **권고 항목** |
| `info` | ⓘ 파랑 | 참고로 알려 주는 **지양 항목** |

검토 패널에서 심각도별로 숨길 수 있으므로, 강제 항목만 먼저 확인하는 식으로 쓸 수 있습니다.

## 정규식 작성 요령

이름 규칙(`*.pattern`)과 `tables`·`columns` 필터는 JavaScript 정규식입니다.

- **작은따옴표로 감싸세요.** YAML에서 `^`, `[`, `{`, `:` 같은 문자가 특별한 의미를 갖지 않게 됩니다.
  ```yaml
  value: '^[a-z][a-z0-9_]*$'
  ```
- 작은따옴표 안에서는 역슬래시를 **한 번만** 씁니다. `'\[PII\]'`는 `[PII]` 글자 그대로를 뜻합니다. 큰따옴표를 쓰면 `"\\[PII\\]"`처럼 두 번 써야 합니다.
- 전체 이름을 검사하려면 `^`와 `$`를 붙입니다. 없으면 이름 **일부**만 맞아도 통과합니다.
- 금지 조건은 부정 전방탐색으로 씁니다.
  ```yaml
  value: '^(?![0-9])(?!.*__)'   # 숫자로 시작 금지, 연속 _ 금지
  tables: '^(?!tmp_|bak_)'      # tmp_, bak_ 테이블은 제외
  ```
- 이름 정규식은 기본적으로 대소문자를 구분합니다. 무시하려면 `ignoreCase: true`를 줍니다. `tables`·`columns` 필터는 항상 대소문자를 무시합니다.

### `{table}` 자리표시자

인덱스·제약·트리거 이름에 테이블명을 넣는 규칙은 `{table}`을 씁니다. 검사할 때 실제 테이블명으로 바뀝니다(정규식 특수문자는 자동으로 처리).

```yaml
- check: index.name.pattern
  value: '^idx_{table}_[0-9]{2}$'     # orders 테이블 → idx_orders_01 만 통과
  ignoreCase: true                    # Oracle 대문자 이름도 통과 (IDX_ORDERS_01)
```

`CREATE INDEX … ON 테이블`과 `ALTER TABLE 테이블 ADD INDEX`도 해당 테이블명으로 바꿔 검사합니다. 트리거는 `ON 테이블`의 테이블명을 씁니다.

## DB별로 나누기

DB마다 기준이 다르면 같은 검사를 `db:`로 나눠 씁니다.

```yaml
- check: table.name.pattern            # MySQL / PostgreSQL: 소문자
  value: '^[a-z][a-z0-9_]*$'
  db: [mysql, postgresql]
- check: table.name.pattern            # Oracle: 대문자
  value: '^[A-Z][A-Z0-9_]*$'
  db: [oracle]
```

검사 자체가 특정 DB에서만 의미 있는 경우(예: `table.engine`은 MySQL)는 다른 DB에서 자동으로 건너뜁니다.

## 자주 쓰는 규칙 예시

### 이름 규칙

```yaml
- check: name.reserved                 # 예약어 단독 사용 금지 (DB별 목록 내장)
  severity: error
- check: column.name.pattern
  value: '^(?![0-9])(?!.*__)'
  severity: error
  message: 숫자로 시작하거나 연속 _를 쓸 수 없습니다
- { check: table.name.maxLength, value: 64, db: [mysql], severity: error }
- { check: table.name.maxLength, value: 30, db: [oracle], severity: error }  # 구버전 Oracle
```

### 코멘트와 개인정보 표기

PostgreSQL·Oracle은 같은 문서 안의 `COMMENT ON TABLE / COLUMN`도 코멘트로 인정합니다.

```yaml
- { check: table.comment.required, severity: error }
- { check: column.comment.required, severity: error }
- check: column.comment.pattern        # 개인정보로 보이는 컬럼은 코멘트에 [PII] 표기
  value: '\[PII(-ENC|-HASH)?\]'
  columns: '(phone|mobile|email|addr|birth)'
  message: 개인정보 컬럼은 코멘트에 [PII] 표기
```

### 필수 컬럼과 접미사

```yaml
- check: table.requiredColumns
  value:
    - { name: created_at, type: datetime }         # 타입까지 확인
    - { name: updated_at, type: [datetime, timestamp] }  # 여러 타입 허용
  tables: '^(?!.*_log$)'                           # 로그 테이블 제외
  db: [mysql]
- check: column.suffix.types           # 접미사 → 타입
  value: { _yn: [bool, tinyint], _at: [datetime], _date: [date] }
  db: [mysql]
- check: column.type.suffixes          # 타입 → 접미사
  value: { datetime: [_at], date: [_date] }
  db: [mysql]
```

### 인덱스·제약·오브젝트 이름

```yaml
- { check: index.name.pattern, value: '^idx_{table}_[0-9]{2}$', ignoreCase: true }
- { check: index.unique.name.pattern, value: '^uk_{table}_[0-9]{2}$', ignoreCase: true }
- { check: foreignKey.name.pattern, value: '^fk_{table}_[0-9]{2}$', ignoreCase: true }
- { check: primaryKey.name.pattern, value: '^PK_{table}$', db: [oracle] }
- { check: primaryKey.name.pattern, value: '^{table}_pkey$', db: [postgresql], allowMissing: true }
- check: object.name.pattern
  ignoreCase: true
  value:
    VIEW: '^vw_'
    PROCEDURE: '^sp_'
    FUNCTION: '^fn_'
    TRIGGER: '^trg_{table}_[0-9]{2}$'
- check: index.redundant               # (a) 인덱스가 있는데 (a, b) 인덱스도 있으면 (a)는 중복
  severity: error
```

{: .note }
이름 규칙은 **이름을 지정하지 않은** 인덱스·제약도 위반으로 봅니다(DB가 임의 이름을 붙이기 때문). PostgreSQL PK처럼 생략해도 규칙대로 이름이 붙는 경우에는 `allowMissing: true`를 주세요. MySQL의 PK 이름은 항상 `PRIMARY`라 PK 이름 검사에서 제외됩니다.

### 문자셋·엔진 (MySQL)

```yaml
- check: table.charset
  value: [utf8mb4]
  allowMissing: true                   # DB 레벨에서 지정하므로 테이블에 안 쓰면 통과
  severity: error
- { check: table.collate, value: [utf8mb4_general_ci, utf8mb4_unicode_ci], allowMissing: true }
- { check: column.charset.forbidden, severity: error }   # 컬럼 단위 지정 금지
```

### 타입 제한

```yaml
- check: column.type.forbidden
  value: [float, double, real]
  columns: '(amt|amount|price|qty)'    # 금액·수량 컬럼만
  severity: error
- { check: column.type.forbidden, value: [enum, set] }
- { check: column.type.maxLength, value: { varchar: 1000, varchar2: 4000 } }
- { check: column.onUpdate.forbidden, severity: error }   # ON UPDATE CURRENT_TIMESTAMP 금지
```

### 운영 중 DDL 위험 (ALTER)

```yaml
- { check: alter.addColumn.notNullWithoutDefault, severity: error }
- { check: alter.addColumn.position, db: [mysql] }          # AFTER / FIRST 금지
- { check: alter.algorithmLock, value: [INSTANT, INPLACE], db: [mysql] }
- { check: index.create.concurrently, db: [postgresql], severity: error }
- { check: index.create.online, db: [oracle], severity: error }
- check: statement.forbidden
  value: [DROP TABLE, TRUNCATE, DROP COLUMN]
  severity: error
```

## 규칙을 만들 때 순서

1. 사내 설계 가이드에서 **강제 항목**부터 `error`로 옮깁니다.
2. 실제 배포 DDL 몇 개를 열어 오탐이 없는지 확인합니다. 패널에서 `ⓘ 정보`를 숨기면 중요한 것만 보입니다.
3. 오탐이 있으면 `tables`·`columns` 필터나 `db`로 범위를 좁힙니다. 특정 테이블만 예외라면 `tables: '^(?!legacy_)'`처럼 제외합니다.
4. 권고 항목을 `warning`·`info`로 추가합니다.
5. 파일 맨 위 주석에 근거 문서 링크를 남겨 두면, 메시지만 보고도 출처를 찾을 수 있습니다.

## 오류 메시지

| 메시지 | 원인 |
| --- | --- |
| `알 수 없는 check '…'` | 검사 이름 오타. [검사 목록](ddl-checks.html) 확인 |
| `value에 정규식 문자열이 필요합니다` | `*.pattern` 검사에 값이 없거나 문자열이 아님 |
| `Invalid regular expression …` | 정규식 문법 오류. 괄호·대괄호 짝, 역슬래시 확인 |
| `value에 목록이 필요합니다` | `[a, b]` 형태가 필요한 검사에 문자열을 넣음 |
| `value에 { 이름: [목록] } 형식이 필요합니다` | 접미사↔타입 검사의 값 형식 오류 |
| `db는 mysql / postgresql / oracle 중에서` | `db:`에 지원하지 않는 이름 |
| `YAML 문법 오류: …` | 들여쓰기·따옴표·콜론 확인 |

오류가 있는 규칙만 건너뛰고 나머지는 적용됩니다. 설정 > DDL 검토에서 오류 목록을 볼 수 있습니다.

## 한계

- 규칙은 **문법(이름·타입·옵션)** 만 봅니다. 데이터 분포, 조회 패턴, 인덱스 컬럼 순서의 적절성, FK 성능 테스트 여부처럼 문서 밖의 정보가 필요한 판단은 하지 않습니다.
- 개인정보 컬럼 판정처럼 의미가 필요한 규칙은 이름 기반의 추정입니다. `columns` 목록을 팀 데이터에 맞게 다듬으세요.
- 검토는 **현재 문서** 안에서만 이루어집니다. 다른 파일의 `COMMENT ON`이나 이미 운영 중인 테이블 정의는 참고하지 않습니다.
