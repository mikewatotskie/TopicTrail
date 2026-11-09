/** Isolated component diagnostics. Never imported by Link Shield or ResourceBrowser. */
export const ACCEPTANCE_PACKAGE = 'com.teamjam.topictrail.acceptance';
export const FIXTURE_ORIGIN = 'http://127.0.0.1:8765';
export const FIXTURES = [
  { path: '/page/one', label: 'Page one' }, { path: '/page/two', label: 'Page two' },
  { path: '/attachment', label: 'Attachment' }, { path: '/redirect/same', label: 'Same redirect' },
  { path: '/redirect/blocked', label: 'Blocked redirect' }, { path: '/popup', label: 'Popup' },
  { path: '/scheme', label: 'Unsupported scheme' }, { path: '/http/404', label: 'HTTP 404' },
  { path: '/http/500', label: 'HTTP 500' }, { path: '/stall', label: '30-second stall' },
] as const;
const fixtureUrls = new Set<string>(FIXTURES.map(fixture => FIXTURE_ORIGIN + fixture.path));

export function isFixtureUrl(value: unknown): value is string {
  // Exact strings also reject credentials, query data, fragments and alternate IP spellings.
  return typeof value === 'string' && fixtureUrls.has(value);
}

export function nativeConstants(config: unknown): unknown {
  return config && typeof config === 'object' && 'Constants' in config ? config.Constants : undefined;
}

export function acceptanceGate(input: { development: boolean; platform: string; packageName: unknown; nativeConfig: unknown }) {
  if (!input.development || input.platform !== 'android' || input.packageName !== ACCEPTANCE_PACKAGE)
    return { enabled: false, reason: 'This route is available only in the isolated Android debug acceptance app.' };
  const constants = nativeConstants(input.nativeConfig);
  if (!constants || typeof constants !== 'object' || !('topicTrailDownloadPolicyVersion' in constants)
    || constants.topicTrailDownloadPolicyVersion !== 1)
    return { enabled: false, reason: 'Native download policy marker 1 is required. No fixture WebView was mounted.' };
  return { enabled: true, reason: 'Actual native download policy marker 1 was read from UIManager.' };
}

export type NativeEventKind = 'request' | 'navigation' | 'load-start' | 'load' | 'load-end'
  | 'progress' | 'error' | 'http-error' | 'open-window' | 'render-process-gone';
export interface AcceptanceNativeEvent {
  sequence: number; kind: NativeEventKind; url: string;
  code?: number; statusCode?: number; loading?: boolean; canGoBack?: boolean; progress?: number;
  allowed?: boolean; popup?: boolean;
}

export function makeNativeEvent(sequence: number, kind: NativeEventKind, data: Record<string, unknown>): AcceptanceNativeEvent {
  const url = isFixtureUrl(data.url) || data.url === 'https://blocked.invalid/' || data.url === 'topictrail-test://denied'
    ? data.url : '[unapproved URL redacted]';
  const event: AcceptanceNativeEvent = { sequence, kind, url };
  for (const key of ['code', 'statusCode', 'progress'] as const)
    if (typeof data[key] === 'number' && Number.isFinite(data[key])) event[key] = data[key];
  for (const key of ['loading', 'canGoBack', 'allowed', 'popup'] as const)
    if (typeof data[key] === 'boolean') event[key] = data[key];
  return event;
}

export function appendNativeEvent(events: readonly AcceptanceNativeEvent[], event: AcceptanceNativeEvent): AcceptanceNativeEvent[] {
  return [...events.slice(-19), event];
}

export function nativeErrorMessage(code: number) {
  return code === -9001 ? 'Native error -9001: automatic download denied.'
    : `Native error ${Number.isFinite(code) ? code : 'unavailable'}: fixture could not load.`;
}
