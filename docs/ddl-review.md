---
title: DDL 검토 사용법
nav_order: 2
---

# DDL 검토 사용법
{: .no_toc }

SQL 문서의 DDL을 팀 규칙으로 검토합니다. 규칙은 앱에 들어 있지 않고, 팀이 직접 만든 YAML 파일을 불러옵니다.
{: .fs-5 .fw-300 }

1. TOC
{:toc}

---

## 1. 규칙 파일 지정

1. 설정(`⌘,` / `Ctrl+,`) → **DDL 검토**를 엽니다.
2. 처음이라면 **템플릿 만들기**를 누릅니다. 모든 검사가 설명과 예시 값까지 주석으로 들어 있는 `ddl-rules.yaml`이 설정 폴더에 생기고 편집기로 열립니다.
3. 쓰려는 규칙의 `#`을 지우고 값을 팀 기준으로 바꿔 저장합니다. 저장하는 즉시 적용됩니다.
4. 팀이 같이 쓰려면 파일을 팀 공용 폴더나 사내 저장소에 두고 **찾아보기…**로 그 경로를 지정합니다.

{: .warning }
회사·팀 규칙에는 내부 명명 규칙이 들어 있으므로 공개 저장소에 올리지 마세요.

규칙 파일에 오류(없는 검사 이름, 잘못된 정규식 등)가 있으면 그 규칙만 건너뛰고, 설정 화면에 어느 규칙이 왜 잘못됐는지 표시합니다. 규칙을 쓰는 방법은 [규칙 작성 가이드](ddl-rules.html)를 보세요.

## 2. 검토 결과 보기

규칙이 적용되면 SQL 문서를 쓰는 동안 자동으로 검토합니다.

- **밑줄** — 위반 위치에 표시되고, 마우스를 올리면 메시지가 나옵니다.
- **상태 표시줄** — `DDL ✕2 ⚠5 ⓘ1`처럼 오류·경고·정보 개수가 나옵니다. 위반이 없으면 `DDL ✓`.
- **오른쪽 검토 패널** — `⇧⌘M`(Windows `Ctrl+Shift+M`), 상태 표시줄 클릭, 또는 보기 메뉴 → **DDL 검토 패널**.
  - 결과를 `CREATE TABLE …` 같은 문장 단위로 묶어 보여줍니다. 문장 머리를 누르면 접힙니다.
  - 상단의 오류·경고·정보 칩을 누르면 그 종류를 숨기거나 다시 보입니다.
  - 항목을 누르면 편집기에서 해당 위치로 이동합니다.
  - **Markdown 복사**로 결과를 표로 복사해 티켓·리뷰 코멘트에 붙일 수 있습니다.
- **다음 / 이전 문제** — `F8` / `⇧F8`.

## 3. 대상 DB

상태 표시줄의 SQL 방언을 따릅니다.

| 방언 | DDL 해석 |
| --- | --- |
| MySQL | MySQL / Aurora / MariaDB 문법. `DELIMITER` 스크립트 지원 |
| PostgreSQL | `COMMENT ON`, `GENERATED … AS IDENTITY`, `CREATE INDEX CONCURRENTLY` 등 |
| Oracle | `COMMENT ON`, `TABLESPACE`, `ONLINE`, PL/SQL 블록(`/`로 끝나는 단위) |

방언을 바꾸면 즉시 다시 검토합니다. 규칙마다 `db:`로 적용할 DB를 정할 수 있습니다.

## 4. 검토하는 문장

| 문장 | 내용 |
| --- | --- |
| `CREATE TABLE` | 테이블·컬럼·인덱스·제약·테이블 옵션 |
| `ALTER TABLE` | ADD / MODIFY / CHANGE / ALTER COLUMN, ADD / DROP INDEX, DROP / RENAME COLUMN, ALGORITHM / LOCK |
| `CREATE INDEX` | 인덱스 이름, CONCURRENTLY / ONLINE |
| `COMMENT ON` | PostgreSQL / Oracle의 테이블·컬럼 코멘트를 같은 문서 안에서 인정 |
| `CREATE VIEW` 등 | VIEW, MATERIALIZED VIEW, SEQUENCE, TRIGGER, PROCEDURE, FUNCTION, PACKAGE, EVENT, SYNONYM의 이름 |
| `DROP` / `TRUNCATE` / `RENAME` | 금지 구문 검사 |

SELECT·INSERT 같은 DML은 검토하지 않습니다.
