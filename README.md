# ArgusCode

SQL · Markdown · JSON · YAML 편집에 맞춘 **가벼운 데스크톱 코드 편집기** (macOS · Windows).

- Go + [Wails v2](https://wails.io) 셸: OS 기본 WebView(macOS WKWebView, Windows WebView2)를 사용해 Electron보다 훨씬 작고 빠름
- 편집기 엔진: [CodeMirror 6](https://codemirror.net)
- 프론트엔드: Vite + TypeScript (프레임워크 없음)

## 기능 (v0.7)

| 영역 | 내용 |
| --- | --- |
| 탐색기 | 폴더 트리(지연 로딩), 새 파일/폴더, 이름 바꾸기(F2), 휴지통으로 이동(`⌘⌫` / `Delete`, 복원 가능), 경로 복사, Finder/탐색기에서 보기, "지원 형식만 표시" 필터, 키보드 이동, 파일 감시로 자동 갱신 |
| 폴더 검색 | `⇧⌘F` 폴더 전체 찾기/바꾸기 — 대소문자·단어 단위·정규식(RE2, 바꾸기에서 `${1}`), 포함/제외 필터(`*.sql`, `db/`), 저장 안 한 편집 내용도 검색, 결과 클릭 시 해당 위치 선택, 파일별/전체 바꾸기 |
| 탭 | 변경 표시(●), 가운데 클릭으로 닫기, 우클릭 메뉴(다른 탭 닫기 등), 드래그로 순서 변경 |
| 분할 | `⌘\` / `Ctrl+\`로 오른쪽 분할(최대 4개), 탭을 편집 영역 오른쪽 끝으로 끌면 분할, 다른 그룹 탭바로 끌어 이동. 같은 파일을 여러 그룹에서 열면 편집 내용이 실시간 동기화 |
| SQL | 하이라이팅, 방언 선택(MySQL / PostgreSQL / Oracle / Standard, 상태바), **SQL 정렬** `⇧⌥F` — 기본은 왼쪽 정렬(SELECT 다음 줄에 컬럼, AND/OR 들여쓰기), 상태바 방언 메뉴에서 River(키워드 오른쪽 정렬, 비교 연산자 정렬)로 전환, 뒤쉼표, `AS` 별칭 세로 정렬, 서브쿼리·CASE 정렬, DDL 정렬(CREATE TABLE 컬럼/타입, ALTER TABLE 동작별 한 줄·컬럼/타입 정렬, CREATE VIEW … AS SELECT, CREATE INDEX·DROP·COMMENT ON 공백 정리), 대소문자는 입력 그대로 유지, 선택 영역만 정렬 가능. **스키마 자동완성** — 폴더 안 `.sql`의 CREATE TABLE/VIEW, ALTER TABLE ADD, COMMENT ON을 읽어 테이블·컬럼(타입, 코멘트)을 제안, 별칭(`o.`)도 인식. 프로시저·트리거·DELIMITER가 있는 문서는 전체 정렬하지 않음(선택 정렬만) |
| SQL 탐색 | 테이블·컬럼에 마우스를 올리면 타입·코멘트 표시, `⌘클릭`/`F12`로 DDL 정의 위치로 이동(별칭 `o.member_id`도 인식), 현재 문장 선택 `⇧⌘A`, 붙여 넣은 값 목록 → `IN (…)` 목록 변환(숫자는 그대로, 문자열은 따옴표, 중복 제거) |
| 개요 | 사이드바 개요 `⌥⌘O` — SQL 문장 목록(바로 위 주석을 설명으로 표시), Markdown 제목, JSON/YAML 키 트리. 클릭하면 이동, 커서 위치 항목 강조, 필터 |
| MongoDB (.js) | mongosh 스크립트 — 구문 강조·구문 오류 표시(`use`/`show` 명령 허용), 자동완성(`db.` 뒤 문서에 나온 컬렉션·db 메서드, 컬렉션·커서 메서드, `rs.`/`sh.` 관리 명령, `$` 조회·수정 연산자와 집계 스테이지·식 — `aggregate([…])` 안에서는 스테이지 우선), 호버 설명, 개요(`use`, `db.컬렉션.메서드`, 함수·변수), 정렬 `⇧⌥F`(js-beautify + 100자 넘는 줄은 괄호 단위로 나눠 파이프라인을 스테이지별 한 줄로) |
| 로그 → mongosh | 우클릭/보기 메뉴 "mongosh 쿼리로 변환" — DocumentDB 프로파일러·감사 로그, MongoDB 슬로우 로그(`attr.command`), currentOp에 남는 명령 문서(`{"find":…,"filter":…,"$db":…,"lsid":…}`)를 `use db` + `db.컬렉션.find(…)` 형태로 새 탭에 변환. find·aggregate·count·distinct·insert·update·delete·findAndModify·createIndexes·explain 지원, 세션 필드(lsid·$clusterTime 등) 제거, Extended JSON(`$oid`·`$date`·`$numberLong`·`$binary` UUID …)을 셸 문법으로, 소요 시간·planSummary·검사 수는 주석으로. 한 줄에 하나씩 여러 건, 선택 영역만도 가능 |
| Shell (.sh) | 구문 강조, 주석 토글, 개요(함수 목록 + 바로 위 주석) |
| Markdown | 하이라이팅(코드 블록 안의 sql/json/yaml 포함), 옆 미리보기 `⇧⌘V` |
| JSON / YAML | 하이라이팅, 실시간 문법 검사, 정렬, 커서 위치 경로(`$.replicas[0].host`) 상태바 표시·클릭 복사, JSON↔YAML 변환(새 탭), 키 이름순 정렬, JSON 한 줄 압축 |
| 실행계획 | `⌥⌘E` — 붙여 넣은 실행계획을 오른쪽 패널에 트리로 표시. MySQL `FORMAT=JSON`(v1·v2)·`FORMAT=TREE`·`EXPLAIN ANALYZE`, PostgreSQL `FORMAT JSON`·텍스트(ANALYZE 포함), Oracle `DBMS_XPLAN.DISPLAY`·`DISPLAY_CURSOR`(`ALLSTATS LAST` 실제 실행값, 조건절·Buffers·파티션·임시 공간·적응형 계획 표시), MongoDB·DocumentDB `explain()`(queryPlanner/executionStats, find·aggregate·샤드, mongosh 출력 그대로) 자동 인식, mysql/psql 표 테두리 자동 제거. 노드별 비용·예상/실제 행·시간·반복, 자체 비용(시간) 막대, 풀스캔·filesort·임시 테이블·디스크 정렬·행 추정 오차·과다 검사(검사 문서 대비 반환 문서) 경고, 가장 무거운 노드 표시, 클릭하면 원문 줄로 이동 |
| 비교 | 저장된 버전과 비교, 다른 탭과 비교(분할 중이면 옆 그룹 문서와 바로 비교) — 나란히 보기, 변경 없는 구간 접기, `F7`/`⇧F7`로 변경 위치 이동 |
| 경량화 | 대용량 모드(3MB 초과 파일은 하이라이트·검사 없이 열기), YAML·비교·Markdown 미리보기 라이브러리는 처음 쓸 때만 로드, 시작 화면에 시작 시간 표시 |
| 파일 처리 | 원자적 저장(임시 파일 → rename), 줄바꿈(LF/CRLF)·UTF-8 BOM 유지 및 전환, 외부 변경 감지(파일 감시 + 창 포커스 시 확인, 저장 안 한 파일은 충돌 알림), 바이너리·20MB 초과 파일 차단 |
| 편집 | 한글 우클릭 메뉴(실행 취소, 잘라내기/복사/붙여넣기, 주석 토글, 대/소문자 변환, 정렬, 찾기/바꾸기, 줄로 이동, 폴더에서 찾기, 분할), 찾기 패널·메뉴 막대 한글화 |
| DDL 검토 | 회사·팀 규칙 파일(YAML)을 설정 > DDL 검토에서 지정하면 SQL 문서의 CREATE TABLE / ALTER TABLE / CREATE INDEX / COMMENT ON / DROP·TRUNCATE를 검토해 밑줄과 오른쪽 검토 패널(`⇧⌘M` 또는 상태 표시줄 클릭 — 문장별로 묶은 결과, 심각도 필터, 클릭하면 해당 위치로 이동, Markdown 표로 복사)로 표시. 다음·이전 문제 `F8`/`⇧F8`. MySQL·PostgreSQL·Oracle (상태 표시줄 SQL 방언 기준). 규칙은 선언형 — 이름 정규식·길이, 코멘트·PK 필수, PK 타입·자동 증가, 필수 컬럼, 엔진·문자셋·콜레이션·테이블스페이스, 금지 타입·길이 제한, NOT NULL/DEFAULT, 인덱스 이름·컬럼 수·중복 인덱스, CONCURRENTLY/ONLINE, 금지 구문, ALTER의 ALGORITHM/LOCK·AFTER·NOT NULL 추가, 예약어(DB별 내장 목록), ON UPDATE 금지, 접미사↔타입(`_yn`·`_at`…), 코멘트 형식(PII 표기 등), NULL 명시, 제약·오브젝트 이름(`idx_{table}_01`처럼 테이블명 자리표시자, PK·FK·CHECK·VIEW·PROCEDURE·SEQUENCE…) 등 44개 검사. 규칙마다 심각도·문구·번호·적용 DB·테이블/컬럼 정규식 필터·대소문자 무시·생략 허용(allowMissing). MySQL `DELIMITER` 스크립트 지원. 규칙은 앱에 없음 — "템플릿 만들기"로 모든 검사가 주석으로 정리된 빈 파일 생성. 규칙 파일을 저장하거나 창으로 돌아오면 다시 적용 |
| 설정 | `⌘,` / `Ctrl+,` (파일 메뉴 → 설정…) — 편집기(글꼴·크기·들여쓰기·줄바꿈·공백 문자 표시), SQL(방언·정렬 스타일·자동완성 키워드 대소문자), 파일(자동 저장 1초 후/포커스 이동 시, 저장 시 줄 끝 공백 제거·마지막 줄바꿈, 외부 변경 감지, 대용량 기준), 정보(버전·시작 시간·설정 위치·초기화). 바꾸는 즉시 적용·저장 |
| 열 수 없는 파일 | 이미지·압축·실행 파일 같은 바이너리와 20MB 넘는 파일은 탐색기·빠른 열기에 흐리게(⊘) 표시하고, 누르면 이유와 "Finder에서 보기"를 안내 |
| 기타 | 빠른 열기 `⌘P`, 세션 복원(폴더·탭·분할·설정), 폴더/파일 드래그 앤 드롭으로 열기, 저장 안 한 파일이 있으면 종료 전 확인, 글꼴 확대/축소 |

## 문서

사용법과 **DDL 검토 규칙 작성 가이드**는 GitHub Pages에 있습니다 → <https://sizzlei.github.io/argusCode/>

- [DDL 검토 사용법](https://sizzlei.github.io/argusCode/ddl-review.html)
- [규칙 작성 가이드](https://sizzlei.github.io/argusCode/ddl-rules.html)
- [검사 목록](https://sizzlei.github.io/argusCode/ddl-checks.html) — `frontend/src/ddlrules.ts`에서 `npm run docs`로 생성 (테스트가 최신인지 확인)

문서 원본은 `docs/` 폴더입니다. 문서의 스크린샷은 `npm run screenshots`(frontend, Playwright 필요)로 다시 찍습니다 — 브라우저 모의 백엔드의 예시 파일로 앱을 띄워 `docs/assets/screenshots/`에 저장합니다. 저장소 Settings → Pages → *Deploy from a branch* · `main` · `/docs`로 게시합니다.

## 단축키

| 동작 | macOS | Windows |
| --- | --- | --- |
| 새 파일 | `⌘N` | `Ctrl+N` |
| 파일 열기 / 폴더 열기 | `⌘O` / `⇧⌘O` | `Ctrl+O` / `Ctrl+Shift+O` |
| 저장 / 다른 이름으로 / 모두 저장 | `⌘S` / `⇧⌘S` / `⌥⌘S` | `Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+Alt+S` |
| 탭 닫기 | `⌘W` | `Ctrl+W` |
| 다음/이전 탭 | `⌃Tab` / `⌃⇧Tab` | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| 빠른 열기 | `⌘P` | `Ctrl+P` |
| 설정 | `⌘,` | `Ctrl+,` |
| 폴더에서 찾기 / 탐색기 | `⇧⌘F` / `⇧⌘E` | `Ctrl+Shift+F` / `Ctrl+Shift+E` |
| 오른쪽으로 분할 / 다음 그룹 / N번째 그룹 | `⌘\` / `⌘K` / `⌘1~4` | `Ctrl+\` / `Ctrl+K` / `Ctrl+1~4` |
| 사이드바 토글 | `⌘B` | `Ctrl+B` |
| 정렬(SQL/JSON/YAML, 선택 시 선택 영역만) | `⇧⌥F` | `Shift+Alt+F` |
| 주석 토글 | `⌘/` | `Ctrl+/` |
| Markdown 미리보기 | `⇧⌘V` | `Ctrl+Shift+V` |
| 찾기·바꾸기 패널 / 다음 찾기 | `⌘F` / `⌘G` | `Ctrl+F` / `Ctrl+G` |
| 줄로 이동 / 같은 단어 다중 선택 | `⌥⌘G` / `⌘D` | `Ctrl+Alt+G` / `Ctrl+D` |
| 확대 / 축소 / 기본 | `⌘=` / `⌘-` / `⌘0` | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| SQL 정의로 이동 | `F12` / `⌘클릭` | `F12` / `Ctrl+클릭` |
| 현재 SQL 문장 선택 | `⇧⌘A` | `Ctrl+Shift+A` |
| 개요 | `⌥⌘O` | `Ctrl+Alt+O` |
| DDL 검토 패널 / 다음 문제 | `⇧⌘M` / `F8` | `Ctrl+Shift+M` / `F8` |
| 실행계획 패널 | `⌥⌘E` | `Ctrl+Alt+E` |
| 비교 화면에서 다음/이전 변경 | `F7` / `⇧F7` | `F7` / `Shift+F7` |

## 개발 환경

필요한 것: Go 1.22+, Node.js 18+, Wails CLI v2

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.2
wails doctor            # 의존성 확인 (macOS는 Xcode Command Line Tools 필요)

cd argusCode
go mod tidy             # go.sum 생성
wails dev               # 핫 리로드 개발 모드
```

UI만 빠르게 확인하려면 브라우저에서도 실행할 수 있습니다. Wails 바인딩이 없으면 메모리 안의 데모 파일 시스템(`/demo`)을 씁니다.

```bash
cd frontend && npm install && npm run dev   # http://localhost:5173
```

테스트:

```bash
go test ./internal/...          # Go: 파일·검색·감시·DDL 파서
cd frontend && npm test         # SQL 포매터 (Node 22.6+)
```

SQL 정렬 예시 (기본: 왼쪽 정렬 / 상태바에서 River로 전환 가능):

```sql
Select
  Max(Rev)
From Revinfo
Where Revtstmp < Unix_Timestamp(Date_Format(Now(), '%Y-%M-01')) * 1000
  and a < b
```

```sql
-- River
SELECT o.member_id,
       COUNT(*)      AS cnt
  FROM orders o
 WHERE o.created_at >= '2026-10-01'
   AND m.grade       = 'VIP'
```

```sql
-- ALTER TABLE: 동작마다 한 줄, ADD/MODIFY 컬럼 이름·타입 정렬
ALTER TABLE orders
    ADD COLUMN    coupon_id    BIGINT UNSIGNED NULL COMMENT '쿠폰' AFTER member_id,
    MODIFY COLUMN memo         VARCHAR(500)    NOT NULL DEFAULT '',
    ADD INDEX idx_orders_coupon (coupon_id),
    ALGORITHM=INPLACE,
    LOCK=NONE;
```

## 빌드

```bash
# macOS (Apple Silicon + Intel 유니버설)
wails build -platform darwin/universal -clean
# → build/bin/ArgusCode.app

# Windows (Windows에서, 또는 macOS에서 크로스 컴파일)
wails build -platform windows/amd64 -clean
# → build/bin/ArgusCode.exe  (Windows 10/11에 기본 포함된 WebView2 사용)
```

### GitHub Actions 자동 빌드

`.github/workflows/build.yml`이 `main` 푸시·PR마다 테스트 후 macOS(universal)·Windows(amd64)를 빌드해 워크플로 아티팩트로 올립니다. `v0.4.0`처럼 `v`로 시작하는 태그를 푸시하면 GitHub Release에 두 파일이 첨부됩니다.

```bash
git tag v0.4.0 && git push origin v0.4.0
```

서명하지 않은 macOS 앱이라 처음 실행 시 차단되면: `xattr -dr com.apple.quarantine /Applications/ArgusCode.app`

명령줄에서 폴더나 파일을 넘겨 열 수 있습니다: `ArgusCode ~/work/sql`

## 구조

```
main.go                   Wails 앱 설정, 네이티브 메뉴(단축키 → 프론트엔드 "cmd" 이벤트)
app.go                    프론트엔드에 바인딩되는 API (대화상자, 파일 시스템, 세션, 종료 확인)
reveal.go                 Finder / 탐색기에서 보기
internal/workspace/       파일 시스템 로직 (Wails 의존 없음, 단위 테스트 포함)
  fs.go                   목록, 읽기(EOL/BOM 감지), 원자적 쓰기, 생성, 이름 바꾸기
  search.go               폴더 검색(병렬, 취소 가능), 바꾸기 (열 위치는 UTF-16 기준)
  state.go                세션 파일 (~/Library/Application Support/ArgusCode, %AppData%\ArgusCode)
internal/sqlschema/       DDL 파서 (CREATE TABLE/VIEW, ALTER ADD, COMMENT ON) → 자동완성용 스키마
internal/watch/           fsnotify 기반 폴더 감시 (보이는 폴더만, 200ms 디바운스)
internal/platform/        휴지통 이동 (macOS NSFileManager, Windows SHFileOperation)
frontend/src/
  main.ts                 부트스트랩, 명령, 단축키, 상태바, 세션
  workbench.ts            문서 · 탭 · 편집 그룹(분할), 저장/다시 읽기, 탭 드래그
  explorer.ts             폴더 트리
  quickopen.ts            빠른 열기
  search.ts               폴더 검색/바꾸기 뷰
  languages.ts            언어 감지, SQL 방언·스키마 자동완성, 문법 검사, 정렬
  sqltools.ts             SQL 호버·정의로 이동·문장 선택·IN 목록
  structure.ts / outline.ts  개요(구문 트리 기반)와 JSON/YAML 경로
  datatools.ts            JSON↔YAML 변환, 키 정렬, 압축 (yaml 지연 로딩)
  plan.ts / planview.ts   실행계획 파서(MySQL/PostgreSQL/Oracle/MongoDB, test/ 에 단위 테스트)와 패널 (지연 로딩)
  jslang.ts / shlang.ts   JavaScript·셸 언어 (처음 열 때 지연 로딩)
  mongotools.ts           mongosh 자동완성·호버
  jswrap.ts               JS 정렬 후 긴 줄을 괄호 단위로 나누기 (test/ 에 단위 테스트)
  diff.ts                 비교 화면 (@codemirror/merge 지연 로딩)
  editormenu.ts           한글 우클릭 메뉴
  ddlparse.ts / ddlrules.ts  DDL 해석(MySQL/PG/Oracle)과 규칙 검사 엔진 (test/ 에 단위 테스트)
  reserved.ts             DB별 예약어 목록 (name.reserved 검사)
  ddlreview.ts            규칙 파일 로딩 + 편집기 진단 (규칙이 있을 때만 지연 로딩)
  reviewpanel.ts          DDL 검토 결과 오른쪽 패널
  settings.ts             설정 화면 (즉시 적용, session.json에 저장)
  stubs/lang-html.ts      Markdown의 HTML 하이라이트 제거용 대체 모듈(번들 약 30% 감소)
  sqlformat.ts            SQL 포매터 — 왼쪽 정렬 / River 두 스타일 (의존성 없음, test/ 에 단위 테스트)
  editor.ts               CodeMirror 기본 설정
  backend.ts              Wails 바인딩 래퍼 + 브라우저용 목(mock)
  ui.ts                   모달, 컨텍스트 메뉴, 토스트
```

설계 메모

- 편집 그룹마다 `EditorView`는 하나뿐이고, 탭을 바꿀 때 `EditorState`만 교체합니다. 탭이 많아도 DOM과 메모리 사용이 거의 늘지 않습니다.
- 같은 파일을 두 그룹에서 열면 탭마다 상태(커서, 실행 취소 기록)는 따로 두고 변경 내용만 서로 전달합니다.
- 단축키는 네이티브 메뉴 가속기와 웹뷰 keydown 양쪽에서 들어올 수 있어 150ms 안의 중복 실행은 무시합니다. macOS에서 복사/붙여넣기가 동작하려면 Edit 메뉴가 꼭 있어야 합니다(다른 OS에서는 역할 메뉴가 없어 macOS에서만 추가).
- 자동 저장 시 줄 끝 공백 제거는 커서가 있는 줄을 건너뜁니다(`select |` 입력 중 공백이 지워지지 않도록). Markdown은 줄 끝 공백 2칸이 줄바꿈이라 제거 대상에서 제외합니다.
- `marked`, `dompurify`는 처음 쓸 때 불러와서(지연 로딩) 시작 속도에 영향이 없습니다. SQL 포매터는 자체 구현이라 외부 라이브러리가 없습니다.
- 포매터는 공백만 바꾸고 토큰 순서는 절대 바꾸지 않으며(테스트로 확인), 두 번 정렬해도 결과가 같습니다.

## 로드맵 아이디어

- SQL: DB에 직접 접속해 스키마 가져오기(선택), 커서 위치 문장만 실행/정렬
- JSON/YAML 상호 변환, JSON Schema 검증
- 라이트 테마
