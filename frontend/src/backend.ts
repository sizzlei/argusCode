// Thin typed wrapper over the Wails bindings (window.go.main.App) and the
// Wails JS runtime. When the page runs in a plain browser (`npm run dev`)
// an in-memory mock file system is used so the UI can be developed alone.

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  ext: string;
}

export interface FileContent {
  path: string;
  content: string;
  modTime: number;
  eol: 'LF' | 'CRLF';
  bom: boolean;
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
  add('/demo/config/app.json', `{"name":"argus","port":8080,"features":["sql","md"]}\n`);
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
  };
}
