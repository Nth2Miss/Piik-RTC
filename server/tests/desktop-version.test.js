import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseVersion } from '../../scripts/desktop-version.mjs';

test('桌面发布版本接受 v 前缀，拒绝空值、版本不一致和非正式版本', () => {
  assert.equal(releaseVersion('1.1.6', '1.1.6'), '1.1.6');
  assert.equal(releaseVersion('v1.1.6', '1.1.6'), '1.1.6');
  for (const input of [undefined, '', '1.1.5', '1.1.6-beta', ' 1.1.6 ', 'v1.1.6\n', '01.1.6', '1.1.6; echo injected']) {
    assert.throws(() => releaseVersion(input, '1.1.6'), /package.json/);
  }
});
