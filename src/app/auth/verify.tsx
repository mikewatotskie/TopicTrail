import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { VerifyEmailScreen } from '../../features/auth/AuthVerification';
import { authOrigin, authSessionId } from '../../features/auth/AuthForm';
export default function VerifyEmailRoute() {
  const { origin, sessionId, purpose } = useLocalSearchParams<{ origin?: string; sessionId?: string; purpose?: string }>();
  return <VerifyEmailScreen origin={authOrigin(origin)} sessionId={authSessionId(sessionId)} purpose={purpose === 'recovery' ? 'recovery' : 'signup'} />;
}
