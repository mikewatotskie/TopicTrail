export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

type FirebaseClientConfigValues = Partial<FirebaseClientConfig>;

const CONFIGURATION_ERROR = 'Firebase configuration is missing or invalid.';

function requiredValue(value: string | undefined): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(CONFIGURATION_ERROR);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error(CONFIGURATION_ERROR);
  return trimmed;
}

export function parseFirebaseClientConfig(values: FirebaseClientConfigValues): FirebaseClientConfig {
  const apiKey = requiredValue(values.apiKey);
  const authDomain = requiredValue(values.authDomain);
  const projectId = requiredValue(values.projectId);
  const appId = requiredValue(values.appId);

  if (!/^AIza[A-Za-z0-9_-]{35}$/.test(apiKey)) throw new Error(CONFIGURATION_ERROR);
  if (!/^[a-z0-9](?:[a-z0-9-]{4,28}[a-z0-9])$/.test(projectId)) throw new Error(CONFIGURATION_ERROR);
  if (authDomain !== `${projectId}.firebaseapp.com`) throw new Error(CONFIGURATION_ERROR);
  if (!/^1:\d{6,}:web:[a-f0-9]{6,}$/i.test(appId)) throw new Error(CONFIGURATION_ERROR);

  return { apiKey, authDomain, projectId, appId };
}

export function readFirebaseClientConfig(): FirebaseClientConfig {
  return parseFirebaseClientConfig({
    apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
    appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  });
}
