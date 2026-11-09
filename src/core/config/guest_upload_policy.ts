export type GuestUploadPolicy = 'disabled' | 'two_guest_successes_v1';
export type GuestUploadPlatform = 'web' | 'android' | 'ios';
export type GuestUploadPolicyConfiguration = Readonly<Record<GuestUploadPlatform, GuestUploadPolicy>>;

// Activation requires separate platform acceptance and explicit owner approval.
export const guestUploadPolicies: GuestUploadPolicyConfiguration = Object.freeze({
  web: 'disabled', android: 'disabled', ios: 'disabled',
});
export function resolveGuestUploadPolicy(platform: string,
  configuration: GuestUploadPolicyConfiguration = guestUploadPolicies): GuestUploadPolicy {
  if (platform !== 'web' && platform !== 'android' && platform !== 'ios') throw Error('Unsupported guest upload platform');
  const policy = configuration[platform];
  if (policy !== 'disabled' && policy !== 'two_guest_successes_v1') throw Error('Invalid guest upload policy');
  return policy;
}
