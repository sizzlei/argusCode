// Thin typed wrapper over the Wails bindings (window.go.main.App) and the
// Wails JS runtime. When the page runs in a plain browser (`npm run dev`)
// an in-memory mock file system is used so the UI can be developed alone.
import deadlockDemo from '../test/fixtures/deadlock/mysql8.txt?raw';

export interface ReleaseInfo {
  version: string;
  tag: string;
  name: string;
  /** Markdown (REST API) */
  notes: string;
  /** HTML (release feed, used when the API is rate limited) */
  notesHtml?: string;
  url: string;
  published: string;
  assetName: string;
  assetUrl: string;
  assetSize: number;
}

export interface UpdateInfo {
  current: string;
  available: boolean;
  /** This OS / build can install updates itself. */
  supported: boolean;
  release: ReleaseInfo;
}

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  ext: string;
  /** Bytes (files only). */
  size?: number;
}

export interface FileContent {
  path: string;
  content: string;
  modTime: number;
  eol: 'LF' | 'CRLF';
  bom: boolean;
}

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
}

export interface Match {
  line: number; // 1-based
  col: number; // UTF-16 offset in line
  len: number;
  before: string;
  text: string;
  after: string;
}

export interface FileMatches {
  path: string;
  rel: string;
  matches: Match[];
}

export interface SearchResult {
  files: FileMatches[];
  total: number;
  filesSearched: number;
  truncated: boolean;
}

export interface ReplaceResult {
  path: string;
  text?: string;
  count: number;
  error?: string;
}

export interface SchemaColumn {
  name: string;
  type: string;
  comment?: string;
  line?: number;
}

export interface SchemaTable {
  schema?: string;
  name: string;
  kind: 'table' | 'view';
  comment?: string;
  file: string;
  line: number;
  columns: SchemaColumn[];
}

export interface FileStat {
  exists: boolean;
  modTime: number;
  size: number;
}

export interface Backend {
  StartPath(): Promise<string>;
  LoadSession(): Promise<string>;
  SaveSession(js: string): Promise<void>;
  SetDirty(dirty: boolean): Promise<void>;
  /** Native menu shortcuts: command → combo ("" = none). */
  SetKeybindings(binds: Record<string, string>): Promise<void>;
  /** Native window colours for the app theme. */
  SetTheme(theme: string): Promise<void>;
  /** GitHub release check against the running version. */
  CheckUpdate(current: string): Promise<UpdateInfo>;
  ReleaseNotes(tag: string): Promise<ReleaseInfo>;
  /** Downloads and installs a release; progress via the "update:progress" event. */
  InstallUpdate(tag: string): Promise<void>;
  /** Starts the installed version and quits. */
  RestartApp(): Promise<void>;
  Quit(): Promise<void>;
  OpenFolderDialog(): Promise<string>;
  OpenFileDialog(): Promise<string>;
  SaveAsDialog(defaultDir: string, defaultName: string): Promise<string>;
  ListDir(dir: string): Promise<Entry[]>;
  ListFiles(root: string): Promise<string[]>;
  ReadFile(path: string): Promise<FileContent>;
  WriteFile(path: string, content: string, eol: string, bom: boolean): Promise<number>;
  Stat(path: string): Promise<FileStat>;
  CreateFile(dir: string, name: string): Promise<string>;
  CreateDir(dir: string, name: string): Promise<string>;
  Rename(path: string, newName: string): Promise<string>;
  RevealInFinder(path: string): Promise<void>;
  IsDir(path: string): Promise<boolean>;
  MoveToTrash(path: string): Promise<void>;
  WatchDirs(dirs: string[]): Promise<void>;
  SearchInFolder(root: string, opts: SearchOptions): Promise<SearchResult>;
  SearchInText(text: string, opts: SearchOptions): Promise<Match[]>;
  ReplaceInText(text: string, opts: SearchOptions, repl: string): Promise<ReplaceResult>;
  ReplaceInFiles(paths: string[], opts: SearchOptions, repl: string): Promise<ReplaceResult[]>;
  ScanSchema(root: string): Promise<SchemaTable[]>;
  StartupMillis(): Promise<number>;
  SettingsDir(): Promise<string>;
}

declare global {
  interface Window {
    go?: { main?: { App?: Backend } };
    runtime?: {
      EventsOn(name: string, cb: (...args: any[]) => void): () => void;
      Environment?(): Promise<{ platform: string }>;
    };
  }
}

/** True when running inside the Wails shell (bindings available). */
export const inWails = () => !!window.go?.main?.App;

let mock: Backend | null = null;

function mockRelease(version: string): ReleaseInfo {
  return {
    version,
    tag: 'v' + version,
    name: `v${version} — 미리보기`,
    notes:
      '## 새 기능\n- **데드락 분석** — `⌥⌘E`로 트랜잭션·락·대기 관계를 봅니다.\n- 라이트 테마\n\n## 수정\n- 드래그 선택 영역이 잘 보이도록 했습니다.',
    url: 'https://github.com/sizzlei/argusCode/releases',
    published: '2026-10-30T00:00:00Z',
    assetName: 'ArgusCode-macos-universal.zip',
    assetUrl: '',
    assetSize: 6_000_000,
  };
}
// Resolve the implementation at call time: the Wails runtime injects
// window.go asynchronously, so it must not be captured at import time.
export const api: Backend = new Proxy({} as Backend, {
  get(_, name: string) {
    return (...args: unknown[]) => {
      const impl: any = window.go?.main?.App ?? (mock ??= createMock());
      return impl[name](...args);
    };
  },
});

/**
 * Resolves once the Wails bindings are available (or immediately in a plain
 * browser). Wails injects /wails/runtime.js into the page.
 */
export function backendReady(timeoutMs = 3000): Promise<void> {
  const injected = !!document.querySelector('script[src*="/wails/"]');
  if (!injected || (window.go?.main?.App && window.runtime)) return Promise.resolve();
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      if ((window.go?.main?.App && window.runtime) || performance.now() - start > timeoutMs) resolve();
      else setTimeout(tick, 20);
    };
    tick();
  });
}

export function onEvent(name: string, cb: (...args: any[]) => void): void {
  window.runtime?.EventsOn(name, cb);
}

/** Clipboard via the Wails runtime (works without a user-gesture prompt in WKWebView). */
export async function copyText(text: string): Promise<void> {
  const rt = (window as any).runtime;
  if (rt?.ClipboardSetText) await rt.ClipboardSetText(text);
  else await navigator.clipboard.writeText(text);
}

/** Opens a URL in the system browser (Wails runtime; window.open in the browser mock). */
export function openUrl(url: string) {
  const rt = (window as any).runtime;
  if (rt?.BrowserOpenURL) rt.BrowserOpenURL(url);
  else window.open(url, '_blank', 'noopener');
}

/** Online documentation (GitHub Pages, built from /docs). */
export const DOCS_URL = 'https://sizzlei.github.io/argusCode/';

export async function readText(): Promise<string> {
  const rt = (window as any).runtime;
  if (rt?.ClipboardGetText) return (await rt.ClipboardGetText()) ?? '';
  return navigator.clipboard.readText();
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Platform-aware path helpers (paths come from the OS as-is). */
export const sep = (p: string) => (p.includes('\\') && !p.includes('/') ? '\\' : '/');
export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? p.slice(0, i + 1) || p : p.slice(0, i);
}
export function join(dir: string, rel: string): string {
  const s = sep(dir);
  return dir.replace(/[\\/]+$/, '') + s + rel.split('/').join(s);
}
export function relative(root: string, p: string): string {
  if (root && p.startsWith(root)) return p.slice(root.length).replace(/^[\\/]/, '');
  return p;
}

// ---------------------------------------------------------------------------
// Browser mock

function createMock(): Backend {
  const files = new Map<string, { content: string; mtime: number }>();
  const dirs = new Set<string>(['/demo', '/demo/sql', '/demo/docs', '/demo/config']);
  const now = Date.now();
  const add = (p: string, c: string) => files.set(p, { content: c, mtime: now });
  add(
    '/demo/sql/orders.sql',
    `-- 주문 집계 쿼리\nSELECT o.member_id,\n       COUNT(*) AS cnt,\n       SUM(o.amount) AS total\nFROM orders o\nWHERE o.created_at >= '2026-10-01'\nGROUP BY o.member_id\nORDER BY total DESC\nLIMIT 100;\n`,
  );
  add(
    '/demo/docs/README.md',
    `# ArgusCode\n\n가벼운 **SQL · Markdown · JSON · YAML** 편집기.\n\n\`\`\`sql\nselect * from dual;\n\`\`\`\n\n- 디렉터리 트리\n- 탭 분할\n`,
  );
  add(
    '/demo/sql/ddl.sql',
    `CREATE TABLE orders (\n  id bigint NOT NULL COMMENT '주문 ID',\n  member_id bigint NOT NULL COMMENT '회원 ID',\n  amount decimal(12,2),\n  created_at datetime,\n  PRIMARY KEY (id)\n) COMMENT='주문';\nCREATE TABLE members (\n  id bigint NOT NULL,\n  grade varchar(10) COMMENT '등급'\n);\n`,
  );
  add('/demo/config/app.json', `{"name":"argus","port":8080,"features":["sql","md"]}\n`);
  dirs.add('/demo/mongo');
  add(
    '/demo/mongo/orders.js',
    `use shop\n\n// 최근 주문 인덱스\ndb.orders.createIndex({ memberId: 1, createdAt: -1 }, { name: 'member_created' });\n\n// VIP 매출 집계\ndb.orders.aggregate([{ $match: { status: 'PAID' } }, { $group: { _id: '$memberId', total: { $sum: '$amount' } } }, { $sort: { total: -1 } }]);\n\nfunction slowOps(sec) {\n  return db.currentOp({ secs_running: { $gt: sec } });\n}\n\nconst vip = db.getCollection('members').find({ grade: 'VIP' }).limit(10);\n`,
  );
  add(
    '/demo/mongo/backup.sh',
    `#!/bin/bash\nset -euo pipefail\n\n# 덤프 경로\nOUT=/backup/$(date +%F)\n\n# 컬렉션 하나 덤프\ndump_one() {\n  mongodump --uri "$MONGO_URI" --collection "$1" --out "$OUT"\n}\n\nfunction main {\n  for c in orders members; do dump_one "$c"; done\n  echo "done: $OUT"\n}\n\nmain "$@"\n`,
  );
  add('/demo/docs/erd.png', '\u0089PNG');
  dirs.add('/demo/migration');
  dirs.add('/demo/rules');
  add(
    '/demo/migration/V2026_11__coupon.sql',
    `-- 쿠폰 발급 테이블
CREATE TABLE coupon_issues (
  id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'ID',
  member_id bigint unsigned NOT NULL COMMENT '회원 ID',
  coupon_cd varchar(20) NOT NULL COMMENT '쿠폰 코드',
  discount_amt float NOT NULL COMMENT '할인 금액',
  used char(1) NOT NULL DEFAULT 'N',
  issued_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '발급 일시',
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정 일시',
  PRIMARY KEY (id),
  KEY ix_member (member_id),
  KEY idx_coupon_issues_01 (member_id, issued_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='쿠폰 발급';

ALTER TABLE coupon_issues ADD COLUMN order_no bigint NOT NULL COMMENT '주문 번호' AFTER member_id;
`,
  );
  add(
    '/demo/migration/V2026_12__orders.sql',
    `-- 주문 테이블 변경
ALTER TABLE orders
  ADD COLUMN coupon_id bigint NULL COMMENT '쿠폰 ID' AFTER member_id,
  MODIFY COLUMN amount decimal(14,2) NOT NULL COMMENT '주문 금액',
  ADD INDEX idx_orders_coupon (coupon_id);

ALTER TABLE members MODIFY COLUMN grade varchar(100) COMMENT '등급';

CREATE INDEX idx_orders_created ON orders (created_at);
`,
  );
  add(
    '/demo/rules/ddl-rules.yaml',
    `# 팀 DDL 규칙 (예시)
version: 1
rules:
  - { id: R-01, check: table.comment.required, severity: error }
  - { id: R-02, check: column.comment.required, severity: error }
  - { id: R-03, check: table.requiredColumns, value: [created_at], severity: error }
  - { id: R-04, check: index.name.pattern, value: '^idx_{table}_[0-9]{2}$', severity: error }
  - { id: R-05, check: index.redundant, severity: error }
  - { id: R-06, check: column.type.forbidden, value: [float, double], columns: '(amt|amount|price)', severity: error }
  - { id: R-07, check: column.onUpdate.forbidden, severity: error }
  - { id: R-08, check: column.suffix.types, value: { _yn: [bool, tinyint] } }
  - { id: R-09, check: column.name.pattern, value: '_(yn|at|id|no|cd|amt|nm|de|date)$|^id$', message: 접미사 규칙을 따르지 않는 컬럼명 }
  - { id: R-10, check: alter.addColumn.notNullWithoutDefault, severity: error }
  - { id: R-11, check: alter.addColumn.position }
  - { id: R-12, check: alter.algorithmLock, value: [INSTANT, INPLACE], severity: info }
`,
  );
  add(
    '/demo/sql/explain_tree.txt',
    `-> Limit: 100 row(s)  (actual time=52.1..52.2 rows=100 loops=1)
    -> Sort: total DESC, limit input to 100 row(s) per chunk  (actual time=52.1..52.1 rows=100 loops=1)
        -> Table scan on <temporary>  (actual time=50.3..51.0 rows=1840 loops=1)
            -> Aggregate using temporary table  (actual time=50.3..50.3 rows=1840 loops=1)
                -> Nested loop inner join  (cost=4021 rows=3300) (actual time=0.2..45.1 rows=9120 loops=1)
                    -> Filter: (o.created_at >= '2026-10-01')  (cost=3350 rows=33000) (actual time=0.1..30.2 rows=33100 loops=1)
                        -> Table scan on o  (cost=3350 rows=99000) (actual time=0.1..25.0 rows=100000 loops=1)
                    -> Filter: (m.grade = 'VIP')  (cost=0.25 rows=0.1) (actual time=0.001..0.001 rows=0.28 loops=33100)
                        -> Single-row index lookup on m using PRIMARY (id=o.member_id)  (cost=0.25 rows=1) (actual time=0.001..0.001 rows=1 loops=33100)
`,
  );
  add('/demo/sql/deadlock.txt', deadlockDemo);
  add('/demo/docs/backup.zip', 'PK');
  add('/demo/config/db.yaml', `primary:\n  host: db.internal\n  port: 3306\nreplicas:\n  - host: r1\n  - host: r2\n`);
  const listDir = (dir: string): Entry[] => {
    const out: Entry[] = [];
    for (const d of dirs)
      if (dirname(d) === dir && d !== dir) out.push({ name: basename(d), path: d, isDir: true, ext: '' });
    for (const f of files.keys())
      if (dirname(f) === dir) {
        const n = basename(f);
        out.push({ name: n, path: f, isDir: false, ext: n.includes('.') ? n.split('.').pop()!.toLowerCase() : '' });
      }
    return out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  };
  let session = '';
  const ok = <T>(v: T) => Promise.resolve(v);
  return {
    StartPath: () => ok(''),
    LoadSession: () => ok(session),
    SaveSession: (js) => {
      session = js;
      return ok(undefined);
    },
    SetDirty: () => ok(undefined),
    SetKeybindings: () => ok(undefined),
    SetTheme: () => ok(undefined),
    // Browser preview: pretend a newer release exists so the update UI can be tried.
    CheckUpdate: (current: string) => ok({ current, available: true, supported: true, release: mockRelease('0.99.0') }),
    ReleaseNotes: (tag: string) => ok(mockRelease(tag.replace(/^v/, ''))),
    InstallUpdate: () => new Promise<void>((r) => setTimeout(r, 800)),
    RestartApp: () => {
      location.reload();
      return ok(undefined);
    },
    Quit: () => ok(undefined),
    OpenFolderDialog: () => ok('/demo'),
    OpenFileDialog: () => ok('/demo/sql/orders.sql'),
    SaveAsDialog: (d, n) => ok(d.replace(/\/$/, '') + '/' + (n || 'untitled.sql')),
    ListDir: (d) => ok(listDir(d)),
    ListFiles: (root) =>
      ok([...files.keys()].filter((f) => f.startsWith(root + '/')).map((f) => f.slice(root.length + 1))),
    ReadFile: (p) => {
      const f = files.get(p);
      if (!f) return Promise.reject('no such file: ' + p);
      return ok({ path: p, content: f.content, modTime: f.mtime, eol: 'LF' as const, bom: false });
    },
    WriteFile: (p, c) => {
      const m = Date.now();
      files.set(p, { content: c, mtime: m });
      return ok(m);
    },
    Stat: (p) => {
      const f = files.get(p);
      return ok(
        f ? { exists: true, modTime: f.mtime, size: f.content.length } : { exists: false, modTime: 0, size: 0 },
      );
    },
    CreateFile: (d, n) => {
      const p = d + '/' + n;
      if (files.has(p)) return Promise.reject('exists');
      add(p, '');
      return ok(p);
    },
    CreateDir: (d, n) => {
      const p = d + '/' + n;
      dirs.add(p);
      return ok(p);
    },
    Rename: (p, n) => {
      const np = dirname(p) + '/' + n;
      const f = files.get(p);
      if (f) {
        files.delete(p);
        files.set(np, f);
      } else if (dirs.has(p)) {
        dirs.delete(p);
        dirs.add(np);
      }
      return ok(np);
    },
    RevealInFinder: () => ok(undefined),
    IsDir: (p) => ok(dirs.has(p)),
    MoveToTrash: (p) => {
      files.delete(p);
      for (const f of [...files.keys()]) if (f.startsWith(p + '/')) files.delete(f);
      for (const d of [...dirs]) if (d === p || d.startsWith(p + '/')) dirs.delete(d);
      return ok(undefined);
    },
    WatchDirs: () => ok(undefined),
    StartupMillis: () => ok(Math.round(performance.now())),
    SettingsDir: () => ok('~/Library/Application Support/ArgusCode'),
    ScanSchema: () =>
      ok([
        {
          name: 'orders',
          kind: 'table' as const,
          comment: '주문',
          file: '/demo/sql/ddl.sql',
          line: 1,
          columns: [
            { name: 'id', type: 'bigint', comment: '주문 ID', line: 2 },
            { name: 'member_id', type: 'bigint', comment: '회원 ID', line: 3 },
            { name: 'amount', type: 'decimal(12,2)', line: 4 },
            { name: 'created_at', type: 'datetime', line: 5 },
          ],
        },
        {
          name: 'members',
          kind: 'table' as const,
          file: '/demo/sql/ddl.sql',
          line: 8,
          columns: [
            { name: 'id', type: 'bigint', line: 9 },
            { name: 'grade', type: 'varchar(10)', comment: '등급', line: 10 },
          ],
        },
      ]),
    SearchInFolder: (root, o) => {
      const re = mockRegex(o);
      const out: FileMatches[] = [];
      let total = 0;
      for (const [p, f] of [...files.entries()].sort()) {
        if (!p.startsWith(root + '/')) continue;
        const ms = mockSearch(f.content, re);
        if (ms.length) out.push({ path: p, rel: p.slice(root.length + 1), matches: ms });
        total += ms.length;
      }
      return ok({ files: out, total, filesSearched: files.size, truncated: false });
    },
    SearchInText: (t, o) => ok(mockSearch(t, mockRegex(o))),
    ReplaceInText: (t, o, r) => {
      const re = mockRegex(o);
      let count = 0;
      const text = t.replace(re, () => (count++, r));
      return ok({ path: '', text, count });
    },
    ReplaceInFiles: (paths, o, r) =>
      ok(
        paths.map((p) => {
          const f = files.get(p)!;
          let count = 0;
          f.content = f.content.replace(mockRegex(o), () => (count++, r));
          f.mtime = Date.now();
          return { path: p, count };
        }),
      ),
  };
}

function mockRegex(o: SearchOptions): RegExp {
  let p = o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) p = `\\b(?:${p})\\b`;
  return new RegExp(p, o.caseSensitive ? 'gm' : 'gim');
}

function mockSearch(text: string, re: RegExp): Match[] {
  const out: Match[] = [];
  text.split('\n').forEach((l, i) => {
    for (const m of l.matchAll(re)) {
      if (!m[0]) continue;
      const col = m.index!;
      out.push({
        line: i + 1,
        col,
        len: m[0].length,
        before: l.slice(Math.max(0, col - 40), col),
        text: m[0],
        after: l.slice(col + m[0].length),
      });
    }
  });
  return out;
}
