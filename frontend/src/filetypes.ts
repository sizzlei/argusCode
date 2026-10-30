// Which files the editor cannot open, so the explorer / quick open can show
// them as such instead of failing on click. Known binary extensions, files
// over the backend's size limit, and files that already failed to open as
// text (remembered for the session).

/** Mirrors workspace.MaxFileSize in the Go backend. */
export const OPEN_LIMIT = 20 * 1024 * 1024;

const BINARY: Record<string, string> = {};
const add = (kind: string, exts: string) => exts.split(' ').forEach((e) => (BINARY[e] = kind));
add('이미지', 'png jpg jpeg gif bmp tif tiff webp ico icns heic heif psd ai sketch fig raw cr2 nef');
add('문서', 'pdf doc docx xls xlsx ppt pptx hwp hwpx odt ods odp pages numbers key');
add('압축 파일', 'zip gz tgz bz2 xz 7z rar tar zst lz4 jar war ear apk ipa dmg iso pkg deb rpm');
add('실행 파일', 'exe dll so dylib a lib o obj class pyc pyo wasm bin app msi');
add('글꼴', 'ttf otf woff woff2 eot');
add('미디어', 'mp3 wav flac aac ogg m4a mp4 mov avi mkv webm wmv');
add('데이터 파일', 'db sqlite sqlite3 mdb accdb ibd frm myd myi dbf parquet avro orc feather pkl npy npz dump bak');

const failed = new Map<string, string>();
let onChange: (() => void) | null = null;

const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

const mb = (n: number) => (n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0) + 'MB';

/** Why a file cannot be opened in the editor, or null when it can. */
export function unopenableReason(path: string, name: string, size?: number): string | null {
  const f = failed.get(path);
  if (f) return f;
  const kind = BINARY[extOf(name)];
  if (kind) return `${kind} (바이너리)`;
  if (size != null && size > OPEN_LIMIT) return `너무 큼 (${mb(size)} > ${mb(OPEN_LIMIT)})`;
  return null;
}

/** Remembers a file that failed to open (from the backend error). */
export function markUnopenable(path: string, error: string) {
  const reason = /binary/i.test(error)
    ? '텍스트가 아닌 파일 (바이너리)'
    : /too large/i.test(error)
      ? '너무 큰 파일'
      : null;
  if (!reason || failed.get(path) === reason) return;
  failed.set(path, reason);
  onChange?.();
}

export function onUnopenableChange(fn: () => void) {
  onChange = fn;
}
