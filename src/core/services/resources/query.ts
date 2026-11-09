import { DiscoveryError, type QueryPlan } from './types';
export const MAX_QUERY_LENGTH = 140;
export const MAX_QUERY_WORDS = 16;
/** The original text is never rewritten; only this separate outbound query is normalized. */
export function prepareQuery(originalText: string, queryOverride?: string): QueryPlan {
  if (typeof originalText !== 'string' || !originalText.trim() || originalText.length > 50000) {
    throw new DiscoveryError('invalid_query', 'Choose a passage of up to 50,000 characters first.');
  }
  const normalized = (queryOverride ?? originalText).normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, ' ').replace(/\s+/gu, ' ').trim();
  const words = normalized.split(' ').slice(0, MAX_QUERY_WORDS);
  let query = '';
  for (const word of words) {
    const next = query ? query + ' ' + word : word;
    if ([...next].length > MAX_QUERY_LENGTH) {
      if (!query) query = [...word].slice(0, MAX_QUERY_LENGTH).join('');
      break;
    }
    query = next;
  }
  const letters = query.match(/[\p{L}\p{N}]/gu) ?? [];
  if (!letters.length || (letters.length < 2 && !/^[\p{L}\p{N}][+#]+$/u.test(query))) {
    throw new DiscoveryError('invalid_query', 'Add a little context to your topic, such as the subject or concept.');
  }
  return { query, originalText, shortened: query !== normalized };
}
