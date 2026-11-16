import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { encodeBase64 } from '../src/core/services/cloud/base64';

test('base64 encodes known vectors and pads trailing bytes', () => {
  const vectors = [
    ['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy'],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(encodeBase64(Buffer.from(plain, 'ascii')), encoded);
  }
  assert.equal(encodeBase64(Uint8Array.of(0xfb, 0xef, 0xff)), '++//');
});

test('base64 matches Node for binary views across output chunks', () => {
  const bytes = randomBytes(125_027);
  for (let trailing = 0; trailing < 3; trailing++) {
    const view = bytes.subarray(3, 125_024 + trailing);
    assert.equal(encodeBase64(view), view.toString('base64'));
  }
});
