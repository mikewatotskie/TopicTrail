interface EmailCallback { purpose: 'signup' | 'recovery'; tokenHash?: string }
let callback: EmailCallback | undefined;
let revision = 0;
const incoming = new Set<() => void>();

/** Retain only a bounded one-time hash in memory; bearer tokens are deliberately never imported. */
export function captureEmailCallback(raw: string): boolean {
  try {
    const end = raw.search(/[?#]/);
    const base = end < 0 ? raw : raw.slice(0, end);
    if (base.length > 2048) return false;
    const url = new URL(base, 'https://topictrail.invalid');
    const match = url.protocol === 'topictrail:' ? url.hostname === 'auth' && url.pathname === '/callback'
      : /^https?:$/.test(url.protocol) && url.pathname === '/auth/callback';
    if (!match) return false;
    callback = undefined;
    try {
      if (raw.length > 16_384 || url.username || url.password) return true;
      const params = new URL(raw, 'https://topictrail.invalid').searchParams;
      if (params.getAll('type').length !== 1 || params.getAll('token_hash').length !== 1) return true;
      const purpose = params.get('type'); const tokenHash = params.get('token_hash')!;
      if ((purpose === 'signup' || purpose === 'recovery') && /^[a-f0-9]{40,128}$/i.test(tokenHash)) callback = Object.freeze({ purpose, tokenHash });
      return true;
    } finally { revision++; for (const listener of incoming) listener(); }
  } catch { return false; }
}
export function getEmailCallback() { return callback; }
export function getEmailCallbackRevision() { return revision; }
export function subscribeEmailCallback(listener: () => void) { incoming.add(listener); return () => { incoming.delete(listener); }; }
// Cleanup from an older mounted action must not erase a newer warm-start link.
export function clearEmailCallback(expectedRevision = revision) { if (expectedRevision === revision) callback = undefined; }
