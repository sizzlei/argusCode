# ArgusCode

SQL · Markdown · JSON · YAML 편집에 맞춘 **가벼운 데스크톱 코드 편집기** (macOS · Windows).

- Go + [Wails v2](https://wails.io) 셸: OS 기본 WebView(macOS WKWebView, Windows WebView2)를 사용해 Electron보다 훨씬 작고 빠름
- 편집기 엔진: [CodeMirror 6](https://codemirror.net)
- 프론트엔드: Vite + TypeScript (프레임워크 없음)

## 기능 (v0.1)

| 영역 | 내용 |
| --- | --- |
| 탐색기 | 폴더 트리(지연 로딩), 새 파일/폴더, 이름 바꾸기(F2), 경로 복사, Finder/탐색기에서 보기, "지원 형식만 표시" 필터, 키보드 이동 |
| 탭 | 변경 표시(●), 가운데 클릭으로 닫기, 우클릭 메뉴(다른 탭 닫기 등), 드래그로 순서 변경 |
| 분할 | `⌘\` / `Ctrl+\`로 오른쪽 분할(최대 4개), 탭을 편집 영역 오른쪽 끝으로 끌면 분할, 다른 그룹 탭바로 끌어 이동. 같은 파일을 여러 그룹에서 열면 편집 내용이 실시간 동기화 |
| SQL | 하이라이팅 + 키워드 자동완성, 방언 선택(MySQL / PostgreSQL / Oracle / Standard, 상태바), `sql-formatter` 정렬 |
| Markdown | 하이라이팅(코드 블록 안의 sql/json/yaml 포함), 옆 미리보기 `⇧⌘V` |
| JSON / YAML | 하이라이팅, 실시간 문법 검사, 정렬 |
| 파일 처리 | 원자적 저장(임시 파일 → rename), 줄바꿈(LF/CRLF)·UTF-8 BOM 유지 및 전환, 외부 변경 감지(창 포커스 시 자동 다시 읽기 / 충돌 알림), 바이너리·20MB 초과 파일 차단 |
| 기타 | 빠른 열기 `⌘P`, 세션 복원(폴더·탭·분할·설정), 폴더/파일 드래그 앤 드롭으로 열기, 저장 안 한 파일이 있으면 종료 전 확인, 글꼴 확대/축소 |

## 단축키

| 동작 | macOS | Windows |
| --- | --- | --- |
| 새 파일 | `⌘N` | `Ctrl+N` |
| 파일 열기 / 폴더 열기 | `⌘O` / `⇧⌘O` | `Ctrl+O` / `Ctrl+Shift+O` |
| 저장 / 다른 이름으로 / 모두 저장 | `⌘S` / `⇧⌘S` / `⌥⌘S` | `Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+Alt+S` |
| 탭 닫기 | `⌘W` | `Ctrl+W` |
| 다음/이전 탭 | `⌃Tab` / `⌃⇧Tab` | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| 빠른 열기 | `⌘P` | `Ctrl+P` |
| 오른쪽으로 분할 / 다음 그룹 / N번째 그룹 | `⌘\` / `⌘K` / `⌘1~4` | `Ctrl+\` / `Ctrl+K` / `Ctrl+1~4` |
| 사이드바 토글 | `⌘B` | `Ctrl+B` |
| 정렬(SQL/JSON/YAML) | `⇧⌥F` | `Shift+Alt+F` |
| Markdown 미리보기 | `⇧⌘V` | `Ctrl+Shift+V` |
| 찾기·바꾸기 패널 / 다음 찾기 | `⌘F` / `⌘G` | `Ctrl+F` / `Ctrl+G` |
| 줄로 이동 / 같은 단어 다중 선택 | `⌥⌘G` / `⌘D` | `Ctrl+Alt+G` / `Ctrl+D` |
| 확대 / 축소 / 기본 | `⌘=` / `⌘-` / `⌘0` | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |

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

Go 백엔드 테스트:

```bash
go test ./internal/...
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

명령줄에서 폴더나 파일을 넘겨 열 수 있습니다: `ArgusCode ~/work/sql`

## 구조

```
main.go                   Wails 앱 설정, 네이티브 메뉴(단축키 → 프론트엔드 "cmd" 이벤트)
app.go                    프론트엔드에 바인딩되는 API (대화상자, 파일 시스템, 세션, 종료 확인)
reveal.go                 Finder / 탐색기에서 보기
internal/workspace/       파일 시스템 로직 (Wails 의존 없음, 단위 테스트 포함)
  fs.go                   목록, 읽기(EOL/BOM 감지), 원자적 쓰기, 생성, 이름 바꾸기
  state.go                세션 파일 (~/Library/Application Support/ArgusCode, %AppData%\ArgusCode)
frontend/src/
  main.ts                 부트스트랩, 명령, 단축키, 상태바, 세션
  workbench.ts            문서 · 탭 · 편집 그룹(분할), 저장/다시 읽기, 탭 드래그
  explorer.ts             폴더 트리
  quickopen.ts            빠른 열기
  languages.ts            언어 감지, SQL 방언, 문법 검사, 정렬
  editor.ts               CodeMirror 기본 설정
  backend.ts              Wails 바인딩 래퍼 + 브라우저용 목(mock)
  ui.ts                   모달, 컨텍스트 메뉴, 토스트
```

설계 메모

- 편집 그룹마다 `EditorView`는 하나뿐이고, 탭을 바꿀 때 `EditorState`만 교체합니다. 탭이 많아도 DOM과 메모리 사용이 거의 늘지 않습니다.
- 같은 파일을 두 그룹에서 열면 탭마다 상태(커서, 실행 취소 기록)는 따로 두고 변경 내용만 서로 전달합니다.
- 단축키는 네이티브 메뉴 가속기와 웹뷰 keydown 양쪽에서 들어올 수 있어 150ms 안의 중복 실행은 무시합니다. macOS에서 복사/붙여넣기가 동작하려면 Edit 메뉴가 꼭 있어야 합니다.
- `sql-formatter`, `marked`, `dompurify`는 처음 쓸 때 불러와서(지연 로딩) 시작 속도에 영향이 없습니다.

## 로드맵 아이디어

- 파일 시스템 감시(fsnotify)로 트리 실시간 갱신
- 폴더 전체 검색 / 바꾸기
- SQL: 스키마 메타데이터 기반 테이블·컬럼 자동완성, 선택 영역만 정렬
- JSON/YAML 상호 변환, JSON Schema 검증
- 라이트 테마, 설정 화면
