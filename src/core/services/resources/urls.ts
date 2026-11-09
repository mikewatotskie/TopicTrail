function httpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || /[\u0000-\u001F\u007F\\]/.test(decodeURIComponent(url.pathname))) return null;
    return url;
  } catch { return null; }
}
export function validateResourceUrl(value: unknown, host = 'en.wikipedia.org'): string | null {
  const url = httpsUrl(value);
  return url?.hostname === host && url.pathname.startsWith('/wiki/') && url.pathname.length > 6 && !url.search && !url.hash ? url.href : null;
}
/** Structural validation only, never a claim about content quality or safety. */
export function isAllowedAttributionUrl(value: unknown): boolean {
  if (validateResourceUrl(value)) return true;
  const url = httpsUrl(value);
  if (!url || url.hash) return false;
  if (url.hostname === 'creativecommons.org') return url.pathname === '/licenses/by-sa/4.0/' && !url.search;
  return url.hostname === 'en.wikipedia.org' && url.pathname === '/w/index.php' &&
    [...url.searchParams.keys()].length === 1 && /^[1-9]\d{0,19}$/.test(url.searchParams.get('oldid') ?? '');
}
