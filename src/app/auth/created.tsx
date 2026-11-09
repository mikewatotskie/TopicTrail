import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { AccountCreatedScreen } from '../../features/auth/AuthScreens';
import { authOrigin, authSessionId } from '../../features/auth/AuthForm';
export default function AccountCreatedRoute() {
  const { origin, sessionId } = useLocalSearchParams<{ origin?: string; sessionId?: string }>();
  return <AccountCreatedScreen origin={authOrigin(origin)} sessionId={authSessionId(sessionId)} />;
}
