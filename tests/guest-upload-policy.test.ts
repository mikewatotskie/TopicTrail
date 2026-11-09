import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGuestUploadPolicy, guestUploadPolicies } from '../src/core/config/guest_upload_policy';
test('all production platforms stay disabled independent of metadata/auth/provider availability', () => {
  for (const platform of ['web', 'android', 'ios']) assert.equal(resolveGuestUploadPolicy(platform), 'disabled');
  assert.deepEqual(guestUploadPolicies, { web: 'disabled', android: 'disabled', ios: 'disabled' });
  assert.throws(() => resolveGuestUploadPolicy('windows'), /platform/i);
});
test('fixture configuration is per platform, immutable and reload/instance isolated', () => {
  const configuration = { web: 'two_guest_successes_v1', android: 'disabled', ios: 'disabled' } as const;
  assert.equal(resolveGuestUploadPolicy('web', configuration), 'two_guest_successes_v1');
  assert.equal(resolveGuestUploadPolicy('android', configuration), 'disabled');
  assert.equal(resolveGuestUploadPolicy('web'), 'disabled'); assert.ok(Object.isFrozen(guestUploadPolicies));
});
