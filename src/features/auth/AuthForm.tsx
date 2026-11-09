import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { TTIconButton, TTFigmaIcon, TTFeedback, TTFeedbackRegion, TTNoticeCard, TTScreen, type FeedbackKind } from '../../components';
import { TTAppBar } from '../../navigation';
import { TTTypography } from '../../core/design/tokens';
import { useTheme } from '../../core/theme/ThemeContext';
import { useAuth } from './AuthContext';
import { AuthAccessLayout } from './AuthAccessLayout';

export type AuthOrigin = 'welcome' | 'settings' | 'upload';
export function authOrigin(value: unknown): AuthOrigin { return value === 'upload' ? 'upload' : value === 'settings' ? 'settings' : 'welcome'; }
export function authSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 160 && /^[a-z0-9]+-[a-z0-9]+$/.test(value) ? value : undefined;
}
export function goAuth(pathname: '/auth/login' | '/auth/register' | '/auth/recovery' | '/auth/created' | '/auth/verify' | '/auth/update-password', origin: AuthOrigin, sessionId?: string) {
  router.replace({ pathname, params: { origin, ...(origin === 'upload' && authSessionId(sessionId) ? { sessionId } : {}) } });
}
export function leaveAuth(origin: AuthOrigin) { router.replace(origin === 'upload' ? '/upload' : origin === 'settings' ? '/(tabs)/settings' : '/welcome'); }
export function validEmail(email: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()); }
export function emailError(email: string) { return !email.trim() ? 'Enter your email address.' : !validEmail(email) ? 'Enter a valid email address.' : undefined; }
export function authErrorCode(error: unknown) { return error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unavailable'; }
export function authError(error: unknown) {
  const message = authErrorMessage(error);
  return error && typeof error === 'object' && 'ambiguousOutcome' in error && error.ambiguousOutcome === true
    ? message + ' We could not confirm whether an account was created. Check your email and existing account confirmation status before attempting registration again.' : message;
}
function authErrorMessage(error: unknown) {
  switch (authErrorCode(error)) {
    case 'network': return 'Check your internet connection and try again.';
    case 'timeout': return 'The account request timed out. Please try again later.';
    case 'cancelled': return 'The account request was interrupted.';
    case 'validation': return 'Check your account details and try again.';
    case 'unauthorized': return 'The account request could not be authenticated. Please try again later.';
    case 'forbidden': return 'This account action is not permitted right now. Please try again later.';
    case 'conflict': return 'The account state changed or conflicts with this request. Check your account status before trying again.';
    case 'server': return 'TopicTrail authentication service is temporarily unavailable. Please try again later.';
    case 'email_submission': return 'Your account email could not be submitted. Please try again later.';
    case 'invalid_response': return 'TopicTrail could not confirm the account request result. Please try again later.';
    case 'invalid_credentials': return 'The email or password is incorrect. Check your details and try again.';
    case 'invalid_email': return 'Enter a valid email address.';
    case 'weak_password': return 'Choose a different, long and unique password and try again.';
    case 'confirmation_required': return 'Verify your email before logging in. Use Verify email to enter your code or request another email.';
    case 'invalid_code': return 'This code or link is invalid or expired. Request a new code and try again.';
    case 'stale_session': return 'Your account session changed. Start this action again.';
    case 'email_in_use': return 'This email is already registered. Try logging in.';
    case 'rate_limit': return 'Too many attempts. Please wait before trying again.';
    case 'busy': return 'Another account action is still running. Please wait.';
    case 'already_signed_in': return 'You are already signed in. Open your account from Settings.';
    case 'account_created': return 'Your account was created, but setup did not finish. Continue to log in to finish signing out.';
    default: return 'Authentication is unavailable. Please try again later.';
  }
}
/** Owns UI lifetime only: no route or state update after the screen loses focus. */
export function useAuthTask(clearSecrets?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const active = useRef(true);
  const generation = useRef(0);
  const clearRef = useRef(clearSecrets);
  useEffect(() => { clearRef.current = clearSecrets; }, [clearSecrets]);
  useFocusEffect(useCallback(() => {
    active.current = true;
    setBusy(pending.current);
    return () => { active.current = false; generation.current++; clearRef.current?.(); };
  }, []));
  async function run(operation: () => Promise<void>, success: () => void, failed?: (error: unknown) => void) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    const started = generation.current;
    try { await operation(); if (active.current && generation.current === started) success(); }
    catch (caught) { if (active.current && generation.current === started) { setError(authError(caught)); failed?.(caught); } }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return { busy, error, setError, run };
}
export function AuthFrame({ title, description, backLabel, onBack, busy = false, children, presentation = 'standard', announcement = 'off' }: {
  title: string; description: string; backLabel: string; onBack: () => void; busy?: boolean; children: React.ReactNode; presentation?: 'standard' | 'access'; announcement?: FeedbackKind;
}) {
  const { colors } = useTheme();
  if (presentation === 'access') return <AuthAccessLayout title={title} description={description} backLabel={backLabel} onBack={onBack} busy={busy}>{children}</AuthAccessLayout>;
  return <TTScreen variant="form">
    <TTAppBar title={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, width: 160, minHeight: 40 }}>
      <View accessible={false} style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
        <Image source={require('./assets/mark-light.svg')} style={{ width: 24, height: 24 }} contentFit="contain" />
      </View><Text style={[TTTypography.title, { color: colors.onBrand, width: 116 }]}>TopicTrail</Text>
    </View>} leading={<TTIconButton icon={<TTFigmaIcon name="back" />} style={{ marginLeft: -8 }} semanticLabel={backLabel} disabled={busy} onPress={onBack} />} />
    <View style={{ height: 4, backgroundColor: colors.accent }} />
    <View style={{ height: 4 }} />
    <KeyboardAvoidingView style={{ flex: 1, minHeight: 0 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 24, paddingBottom: 24, gap: 16 }}>
        <TTFeedbackRegion kind={announcement} style={{ gap: 8 }}><Text accessibilityRole="header" style={[TTTypography.heading, { color: colors.ink }]}>{title}</Text>
          <Text style={[TTTypography.small, { color: colors.muted }]}>{description}</Text></TTFeedbackRegion>
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  </TTScreen>;
}
export function AuthAvailability() {
  const { state } = useAuth();
  if (state.status === 'unavailable') return <TTNoticeCard announcement="alert" title="Authentication unavailable" message="Account services are unavailable in this app session. You can still read your existing files as a guest." />;
  if (state.status === 'loading') return <TTNoticeCard announcement="status" title="Checking account" message="Please wait while your account session is checked." />;
  return null;
}
export function AuthInfo({ message, announcement = 'off' }: { message: string; announcement?: FeedbackKind }) {
  const { colors, colorScheme } = useTheme();
  return <View style={{ gap: 8, flexDirection: 'row', alignItems: 'flex-start', backgroundColor: colors.soft, padding: 16, borderRadius: 12 }}>
    <Image source={colorScheme === 'dark' ? require('./assets/shield-dark.svg') : require('./assets/shield-light.svg')}
      style={{ width: 24, height: 24 }} contentFit="contain" accessible={false} />
    <TTFeedback kind={announcement} message={message} style={[TTTypography.small, { flex: 1, color: colors.link }]} />
  </View>;
}
