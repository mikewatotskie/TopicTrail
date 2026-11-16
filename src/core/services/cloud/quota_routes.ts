import { strToU8 } from 'fflate';
import { sha256 } from './sha256';

// Fingerprint of TopicTrail's public release project identifier. No API key or credential.
const releaseProject = '4c842c737fda4feff2164a5f87099f2409a3c6d00dda0c90b9a90f6c2d2f74fe';

/** Expo inlines this public staging project reference at build time. No automatic fallback to unrestricted routes. */
export function usesStagingQuotas(project: string): boolean {
  const staging = process.env.EXPO_PUBLIC_TOPICTRAIL_QUOTA_STAGING_REF;
  if (!staging) return false;
  if (!/^[a-z0-9]{20}$/.test(staging) || staging !== project || sha256(strToU8(project)) === releaseProject) {
    throw new Error('The quota staging configuration does not match the connected cloud project.');
  }
  return true;
}
