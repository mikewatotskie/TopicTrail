import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { LoginScreen } from '../../features/auth/AuthScreens';
import { authOrigin, authSessionId } from '../../features/auth/AuthForm';
export default function LoginRoute() {
  const { origin, sessionId } = useLocalSearchParams<{ origin?: string; sessionId?: string }>();
  return <LoginScreen origin={authOrigin(origin)} sessionId={authSessionId(sessionId)} />;
}
