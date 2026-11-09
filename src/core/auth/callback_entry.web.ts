import { captureEmailCallback } from './email_callback';

// Run before Expo Router. Do not put codes, hashes, bearer tokens or provider errors in router state.
if (typeof window !== 'undefined' && window.location.pathname === '/auth/callback') {
  captureEmailCallback(window.location.href);
  window.history.replaceState(null, '', '/auth/callback');
}
