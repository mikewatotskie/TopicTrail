import { AuthOperationError } from './types';

export interface SupabaseConfiguration { url: string; publishableKey: string; namespace: string }
export function validateSupabaseConfiguration(url: unknown, key: unknown): SupabaseConfiguration {
  const invalid = () => new AuthOperationError('unavailable', 'Supabase public configuration is missing or invalid.');
  if (typeof url !== 'string' || typeof key !== 'string') throw invalid();
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { throw invalid(); }
  // Only the existing hosted project API and a public publishable key belong in this client.
  if (parsed.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(parsed.hostname)
    || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/'
    || !/^sb_publishable_[A-Za-z0-9_-]{20,200}$/.test(key.trim())) throw invalid();
  return Object.freeze({ url: parsed.origin, publishableKey: key.trim(), namespace: parsed.hostname.split('.')[0] });
}
export function readSupabaseConfiguration(): SupabaseConfiguration {
  // Static dot access is required by Expo's public-variable transform.
  return validateSupabaseConfiguration(process.env.EXPO_PUBLIC_SUPABASE_URL, process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}
