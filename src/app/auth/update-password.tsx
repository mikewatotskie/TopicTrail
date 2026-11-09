import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { UpdatePasswordScreen } from '../../features/auth/AuthVerification';
import { authOrigin, authSessionId } from '../../features/auth/AuthForm';
export default function UpdatePasswordRoute() {
  const { origin, sessionId } = useLocalSearchParams<{ origin?: string; sessionId?: string }>();
  return <UpdatePasswordScreen origin={authOrigin(origin)} sessionId={authSessionId(sessionId)} />;
}
