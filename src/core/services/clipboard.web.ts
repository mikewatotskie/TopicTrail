/** Only a fulfilled browser write confirms success. Do not mask failure with legacy copy. */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
    throw new Error('Browser clipboard writing is unavailable.');
  }
  await navigator.clipboard.writeText(text);
}
