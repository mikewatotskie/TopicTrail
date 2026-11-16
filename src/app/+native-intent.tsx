import { isLegacyEmailCallbackPath } from '../core/auth/email_callback';

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  // Discard callback parameters before an unregistered link can enter router state.
  if (path.length > 16_384) return '/auth/login';
  try {
    const url = new URL(path, 'https://topictrail.invalid');
    const name = decodeURIComponent(url.pathname).replace(/\/$/, '');
    if (url.protocol === 'topictrail:' && url.host === 'auth' && name === '/callback') return '/auth/callback';
    if (isLegacyEmailCallbackPath(name) || name === '/callback') return '/auth/login';
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (['code', 'token_hash', 'access_token', 'refresh_token', 'error_description'].some(
      key => url.searchParams.has(key) || fragment.has(key))) return '/auth/login';
  } catch { return '/auth/login'; }
  return path;
}
