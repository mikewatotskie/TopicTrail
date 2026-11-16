import React from 'react';
import { NativeModules, Platform } from 'react-native';
import { Redirect } from 'expo-router';
import { AcceptanceScreen } from '../features/acceptance/AcceptanceScreen';
import { ACCEPTANCE_PACKAGE } from '../features/acceptance/policy';

/** Explicit deep-link diagnostics only; no normal user navigation points here. */
export default function AcceptanceRoute() {
  if (!__DEV__ || Platform.OS !== 'android' || NativeModules.TopicTrailTransfer?.packageName !== ACCEPTANCE_PACKAGE)
    return <Redirect href="/" />;
  return <AcceptanceScreen />;
}
