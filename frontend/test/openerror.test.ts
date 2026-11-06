import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openErrorMessage } from '../src/openerror.ts';

test('open error messages', () => {
  assert.match(openErrorMessage('a.sql', 'open /Users/x/Desktop/a.sql: operation not permitted', true), /권한.*시스템 설정/);
  assert.match(openErrorMessage('a.sql', 'open C:\\a.sql: Access is denied.', false), /권한이 없습니다\. 파일 권한/);
  assert.match(openErrorMessage('a.bin', 'binary file'), /텍스트 파일이 아니라/);
  assert.match(openErrorMessage('a.sql', 'stat /x/a.sql: no such file or directory'), /찾을 수 없습니다/);
  assert.match(openErrorMessage('a.sql', 'file is too large (300 MB)'), /너무 커서/);
  assert.equal(openErrorMessage('a.sql', 'boom'), '열 수 없습니다: a.sql — boom');
});
