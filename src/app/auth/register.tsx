import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { RegistrationScreen } from '../../features/auth/AuthScreens';
import { authOrigin, authSessionId } from '../../features/auth/AuthForm';
export default function RegistrationRoute() {
  const { origin, sessionId } = useLocalSearchParams<{ origin?: string; sessionId?: string }>();
  return <RegistrationScreen origin={authOrigin(origin)} sessionId={authSessionId(sessionId)} />;
}
