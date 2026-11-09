import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { getApps, deleteApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

test('retained Firebase rollback factory is lazy, reuses one gateway and hydrates guest without a network sign-in', async () => {
  assert.ok(existsSync('src/core/auth/firebase_session.ts'), 'Firebase rollback factory is not retained');
  const { getTopicTrailFirebaseGateway: getTopicTrailAuthGateway } = await import('../src/core/auth/firebase_session');
  assert.equal(getApps().some(app => app.name === 'topictrail'), false);
  const values = {
    EXPO_PUBLIC_FIREBASE_API_KEY: 'AIza' + 'x'.repeat(35),
    EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: 'topictrail-test.firebaseapp.com',
    EXPO_PUBLIC_FIREBASE_PROJECT_ID: 'topictrail-test',
    EXPO_PUBLIC_FIREBASE_APP_ID: '1:123456789:web:abcdef123456',
  };
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    const gateway = getTopicTrailAuthGateway();
    assert.equal(getTopicTrailAuthGateway(), gateway);
    const app = getApps().find(value => value.name === 'topictrail'); assert.ok(app);
    await getAuth(app).authStateReady(); await Promise.resolve();
    assert.deepEqual(gateway.getSnapshot(), { status: 'guest' });
    assert.equal(getAuth(app).currentUser, null);
    gateway.dispose();
    const replacement = getTopicTrailAuthGateway(); assert.notEqual(replacement, gateway);
    await getAuth(app).authStateReady(); await Promise.resolve();
    assert.deepEqual(replacement.getSnapshot(), { status: 'guest' });
    replacement.dispose(); await deleteApp(app);
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
