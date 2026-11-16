export function isOwnedDocumentUri(path: string, directory: string): boolean {
  try {
    if (!path.startsWith('file:///') || /[\\?#\u0000-\u001f\u007f]|%(?:00|2f|5c|25)/i.test(path) ||
        decodeURIComponent(path).split('/').some(segment => segment === '.' || segment === '..')) return false;
    const target = new URL(path);
    const root = new URL(directory);
    if (target.protocol !== 'file:' || root.protocol !== 'file:' || target.host !== root.host || target.search || target.hash) return false;
    const prefix = decodeURIComponent(root.pathname).replace(/\/+$/, '') + '/';
    const normalized = decodeURIComponent(target.pathname);
    const child = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : '';
    return !!child && child !== '.' && child !== '..' && !/[\\/]/.test(child);
  } catch { return false; }
}
