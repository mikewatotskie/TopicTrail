import { isLegacyEmailCallbackPath } from './email_callback';

// Clean up old email links before Expo Router initializes. Verification now uses typed codes.
if (typeof window !== 'undefined' && isLegacyEmailCallbackPath(window.location.pathname)) {
  window.history.replaceState(null, '', '/auth/callback');
}
export {};
