import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { RecoveryScreen } from '../../features/auth/AuthScreens';
import { authOrigin, authSessionId } from '../../features/auth/AuthForm';
export default function RecoveryRoute() {
  const { origin, sessionId } = useLocalSearchParams<{ origin?: string; sessionId?: string }>();
  return <RecoveryScreen origin={authOrigin(origin)} sessionId={authSessionId(sessionId)} />;
}
