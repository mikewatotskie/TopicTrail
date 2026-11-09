import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { readFirebaseClientConfig } from './config';

const APP_NAME = 'topictrail';

export function getTopicTrailFirebaseApp(): FirebaseApp {
  const config = readFirebaseClientConfig();
  const existing = getApps().find(app => app.name === APP_NAME);
  if (existing) {
    const options = existing.options;
    if (options.apiKey !== config.apiKey
      || options.authDomain !== config.authDomain
      || options.projectId !== config.projectId
      || options.appId !== config.appId) {
      throw new Error('Firebase configuration does not match the existing TopicTrail app.');
    }
    return getApp(APP_NAME);
  }
  return initializeApp(config, APP_NAME);
}
