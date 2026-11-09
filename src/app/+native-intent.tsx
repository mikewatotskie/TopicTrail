import { captureEmailCallback } from '../core/auth/email_callback';

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return captureEmailCallback(path) ? '/auth/callback' : path;
}
