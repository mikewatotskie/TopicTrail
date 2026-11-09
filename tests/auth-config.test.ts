import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { deleteApp, getApps, initializeApp } from 'firebase/app';
import type { FirebaseClientConfig } from '../src/core/auth/config';

const sample: FirebaseClientConfig = {
  apiKey: `AIza${'A'.repeat(35)}`,
  authDomain: 'topictrail-test.firebaseapp.com',
  projectId: 'topictrail-test',
  appId: '1:123456789012:web:abcdef0123456789abcdef',
};

const envKeys = [
  'EXPO_PUBLIC_FIREBASE_API_KEY',
  'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
  'EXPO_PUBLIC_FIREBASE_APP_ID',
] as const;

const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));
function setEnv(config: Partial<FirebaseClientConfig>) {
  const values = [config.apiKey, config.authDomain, config.projectId, config.appId];
  envKeys.forEach((key, index) => {
    if (values[index] === undefined) delete process.env[key];
    else process.env[key] = values[index];
  });
}

after(async () => {
  await Promise.all(getApps().filter(app => app.name === 'topictrail').map(deleteApp));
  envKeys.forEach(key => {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

test('parses and trims valid public config fields', async () => {
  const { parseFirebaseClientConfig } = await import('../src/core/auth/config');
  assert.deepEqual(parseFirebaseClientConfig({
    apiKey: `  ${sample.apiKey} `,
    authDomain: ` ${sample.authDomain} `,
    projectId: ` ${sample.projectId} `,
    appId: ` ${sample.appId} `,
  }), sample);
});

test('rejects missing, blank, malformed, and control-character values without exposing them', async () => {
  const { parseFirebaseClientConfig } = await import('../src/core/auth/config');
  const cases: Partial<FirebaseClientConfig>[] = [
    { ...sample, apiKey: undefined },
    { ...sample, projectId: '   ' },
    { ...sample, apiKey: 'PRIVATE_VALUE' },
    { ...sample, authDomain: 'other.firebaseapp.com' },
    { ...sample, projectId: 'UPPERCASE' },
    { ...sample, appId: '1:abc:web:bad' },
    { ...sample, appId: `${sample.appId}\nPRIVATE_VALUE` },
  ];
  for (const input of cases) {
    assert.throws(() => parseFirebaseClientConfig(input), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Firebase configuration/i);
      assert.doesNotMatch(error.message, /PRIVATE_VALUE|AIza|topictrail-test|other\.firebaseapp\.com/);
      return true;
    });
  }
});

test('reads Expo public variables through static property access', async () => {
  setEnv(sample);
  const { readFirebaseClientConfig } = await import('../src/core/auth/config');
  assert.deepEqual(readFirebaseClientConfig(), sample);
});

test('importing the lazy app module does not initialize Firebase', async () => {
  await Promise.all(getApps().filter(app => app.name === 'topictrail').map(deleteApp));
  const before = getApps().length;
  await import('../src/core/auth/firebase_app');
  assert.equal(getApps().length, before);
});

test('initializes the named app once and rejects a conflicting pre-existing config', async () => {
  setEnv(sample);
  const { getTopicTrailFirebaseApp } = await import('../src/core/auth/firebase_app');
  const app = getTopicTrailFirebaseApp();
  assert.equal(app.name, 'topictrail');
  assert.equal(getTopicTrailFirebaseApp(), app);
  await deleteApp(app);

  const wrong = initializeApp({ ...sample, projectId: 'different-project', authDomain: 'different-project.firebaseapp.com' }, 'topictrail');
  try {
    assert.throws(() => getTopicTrailFirebaseApp(), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Firebase configuration/i);
      assert.doesNotMatch(error.message, /different-project|topictrail-test|AIza/);
      return true;
    });
  } finally {
    await deleteApp(wrong);
  }
});



