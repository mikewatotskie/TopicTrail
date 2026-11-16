const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CHUNK_BYTES = 12 * 1024;

export function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const complete = bytes.length - (bytes.length % 3);

  // Join bounded groups first so large files do not build one deep string rope.
  for (let start = 0; start < complete; start += CHUNK_BYTES) {
    const end = Math.min(start + CHUNK_BYTES, complete);
    const groups: string[] = [];
    for (let index = start; index < end; index += 3) {
      const value = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
      groups.push(ALPHABET[value >>> 18] + ALPHABET[(value >>> 12) & 63] +
        ALPHABET[(value >>> 6) & 63] + ALPHABET[value & 63]);
    }
    chunks.push(groups.join(''));
  }

  if (complete < bytes.length) {
    const first = bytes[complete];
    const hasSecond = complete + 1 < bytes.length;
    const second = hasSecond ? bytes[complete + 1] : 0;
    chunks.push(ALPHABET[first >>> 2] + ALPHABET[((first & 3) << 4) | (second >>> 4)] +
      (hasSecond ? ALPHABET[(second & 15) << 2] + '=' : '=='));
  }

  return chunks.join('');
}
