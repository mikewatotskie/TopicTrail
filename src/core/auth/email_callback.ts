/** Match only the path of an old email link. Its query and fragment never enter app state. */
export function isLegacyEmailCallbackPath(pathname: string): boolean {
  return pathname === '/auth/callback' || pathname === '/auth/callback/';
}
