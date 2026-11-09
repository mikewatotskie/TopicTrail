import { canonicalBookmarkUrl } from '../link_shield';
import type { Attribution } from '../resources/types';
import type { Bookmark, BookmarkInput } from './types';

export const MAX_BOOKMARKS = 500;
export const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const inputKeys = ['url', 'title', 'providerId', 'providerName', 'type', 'description', 'topic', 'attribution'];
const attributionKeys = ['author', 'licenseName', 'licenseUrl', 'sourceUrl', 'revisionUrl'];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid saved resource metadata.');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length > maximum * 2 || !value.trim() ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value) || [...value].length > maximum) {
    throw Error(`Invalid saved resource ${label}.`);
  }
  return value.trim();
}
function url(value: unknown): string {
  const normalized = canonicalBookmarkUrl(value);
  if (!normalized) throw Error('This resource link cannot be saved.');
  return normalized;
}
function attribution(value: unknown): Readonly<Attribution> {
  const input = record(value);
  if (Object.keys(input).some(key => !attributionKeys.includes(key))) throw Error('Invalid resource attribution.');
  return Object.freeze({ author: text(input.author, 300, 'author'), licenseName: text(input.licenseName, 120, 'license'),
    licenseUrl: url(input.licenseUrl), sourceUrl: url(input.sourceUrl),
    ...(input.revisionUrl === undefined ? {} : { revisionUrl: url(input.revisionUrl) }) });
}
/** Copies an allowlist of bounded fields at the call boundary, before any queued IO. */
export function validateBookmarkInput(value: unknown): BookmarkInput {
  const input = record(value);
  if (input.type !== 'Article') throw Error('Unsupported saved resource type.');
  return Object.freeze({ url: url(input.url), title: text(input.title, 300, 'title'),
    providerId: text(input.providerId, 80, 'provider'), providerName: text(input.providerName, 120, 'source'), type: 'Article',
    ...(input.description === undefined ? {} : { description: text(input.description, 2000, 'description') }),
    ...(input.topic === undefined ? {} : { topic: text(input.topic, 140, 'topic') }),
    ...(input.attribution === undefined ? {} : { attribution: attribution(input.attribution) }) });
}
/** Bound UTF-8 without relying on a platform TextEncoder or allocating another copy. */
export function assertMetadataSize(json: string): void {
  if (json.length > MAX_METADATA_BYTES) throw Error('Saved resource metadata is too large.');
  let bytes = 0;
  for (const character of json) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7F ? 1 : point <= 0x7FF ? 2 : point <= 0xFFFF ? 3 : 4;
    if (bytes > MAX_METADATA_BYTES) throw Error('Saved resource metadata is too large.');
  }
}
export function decodeBookmarks(json: string): readonly Bookmark[] {
  assertMetadataSize(json);
  const envelope = record(JSON.parse(json));
  if (envelope.version !== 1 || Object.keys(envelope).some(key => key !== 'version' && key !== 'bookmarks') ||
      !Array.isArray(envelope.bookmarks) || envelope.bookmarks.length > MAX_BOOKMARKS) throw Error('Invalid bookmark envelope.');
  const ids = new Set<string>(); const urls = new Set<string>();
  const bookmarks = envelope.bookmarks.map(value => {
    const input = record(value);
    if (Object.keys(input).some(key => ![...inputKeys, 'id', 'savedAt'].includes(key))) throw Error('Invalid saved resource metadata.');
    const fields = validateBookmarkInput(input);
    const id = text(input.id, 100, 'identifier');
    if (typeof input.savedAt !== 'string' || input.savedAt.length !== 24 ||
        !Number.isFinite(Date.parse(input.savedAt)) || new Date(input.savedAt).toISOString() !== input.savedAt || ids.has(id) || urls.has(fields.url)) {
      throw Error('Invalid or duplicate saved resource metadata.');
    }
    ids.add(id); urls.add(fields.url);
    return Object.freeze({ ...fields, id, savedAt: input.savedAt });
  });
  // Newest first; preserve insertion ordering for records sharing a clock tick.
  return Object.freeze(bookmarks.sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
}
export function encodeBookmarks(bookmarks: readonly Bookmark[]): string {
  if (bookmarks.length > MAX_BOOKMARKS) throw Error('Your saved resource library is full. Remove a resource before saving another.');
  const json = JSON.stringify({ version: 1, bookmarks }); assertMetadataSize(json); return json;
}
