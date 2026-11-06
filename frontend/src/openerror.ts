// Turns a backend error from opening a file into a message the user can act on.

const isMacUA = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

export function openErrorMessage(name: string, msg: string, mac = isMacUA()): string {
  if (/binary/i.test(msg)) return `'${name}'은(는) 텍스트 파일이 아니라 편집기로 열 수 없습니다.`;
  if (/operation not permitted|permission denied|access is denied/i.test(msg)) {
    return mac
      ? `'${name}'을(를) 읽을 권한이 없습니다. 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더(또는 전체 디스크 접근 권한)에서 ArgusCode를 허용한 뒤 다시 시도해 주세요.`
      : `'${name}'을(를) 읽을 권한이 없습니다. 파일 권한을 확인해 주세요.`;
  }
  if (/no such file|cannot find|not exist/i.test(msg)) return `'${name}'을(를) 찾을 수 없습니다. 이동되었거나 삭제된 파일일 수 있습니다.`;
  if (/too large/i.test(msg)) return `'${name}'은(는) 너무 커서 열 수 없습니다.`;
  return `열 수 없습니다: ${name} — ${msg}`;
}
