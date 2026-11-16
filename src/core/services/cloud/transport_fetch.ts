/** Expo's native fetch supports binary ArrayBuffer requests/responses. Auth keeps its separate guarded transport. */
export const cloudFetch: typeof globalThis.fetch = (...args) => {
  // Load native network modules only when an authenticated sync actually starts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {fetch} = require('expo/fetch') as typeof import('expo/fetch');
  return (fetch as typeof globalThis.fetch)(...args);
};
