import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReaderMessage } from '../src/features/reader/selection';
import { parseWebReaderEvent, validateCachedOcr } from '../src/features/reader/reader_protocol';

test('OCR result messages are bounded and require valid confidence/page', () => {
  const valid = { type: 'ocr-result', page: 2, text: 'Recognized text', confidence: 91, truncated: false };
  assert.deepEqual(parseReaderMessage(JSON.stringify(valid)), valid);
  for (const change of [{ page: 0 }, { page: 1.5 }, { confidence: -1 }, { confidence: 101 }, { confidence: null }, { text: 'a'.repeat(50001) }, { truncated: 'no' }]) {
    assert.equal(parseReaderMessage(JSON.stringify({ ...valid, ...change })), null);
  }
  assert.equal(parseWebReaderEvent({ protocol: 1, session: 'current', generation: 2, message: valid }, 'current', 3), null);
});

test('OCR status messages reject unbounded/unknown state', () => {
  const valid = { type: 'ocr-status', page: 1, state: 'running', progress: 0.3, message: 'Recognizing text' };
  assert.deepEqual(parseReaderMessage(JSON.stringify(valid)), valid);
  for (const change of [{ state: 'uploaded' }, { progress: 1.1 }, { progress: null }, { message: 4 }]) {
    assert.equal(parseReaderMessage(JSON.stringify({ ...valid, ...change })), null);
  }
});

test('cached OCR commands accept text as data, with bounded explicit page', () => {
  assert.equal(validateCachedOcr({ page: 1, text: '<script>not executable</script>', confidence: 88, truncated: false }), true);
  for (const value of [null, [], {}, { page: 0, text: 'hello', confidence: 90 }, { page: 1, text: 'x'.repeat(50001), confidence: 90 }, { page: 1, text: 'hello', confidence: Infinity }]) {
    assert.equal(validateCachedOcr(value), false);
  }
});
