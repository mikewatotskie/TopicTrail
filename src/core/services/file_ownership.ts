export function isOwnedDocumentUri(path: string, directory: string): boolean {
  try {
    const target = new URL(path);
    const root = new URL(directory);
    if (target.protocol !== 'file:' || root.protocol !== 'file:' || target.host !== root.host || target.search || target.hash) return false;
    const prefix = decodeURIComponent(root.pathname).replace(/\/+$/, '') + '/';
    const normalized = decodeURIComponent(target.pathname);
    const child = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : '';
    return !!child && child !== '.' && child !== '..' && !/[\\/]/.test(child);
  } catch { return false; }
}
