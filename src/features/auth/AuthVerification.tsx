import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { TTButton, TTFeedback, TTNoticeCard } from '../../components';
import { useAuth } from './AuthContext';
import { AuthField } from './AuthField';
import { AuthAvailability, AuthFrame, authOrigin, emailError, goAuth, useAuthTask, type AuthOrigin } from './AuthForm';

export function EmailSetupNotice() {
  return <TTNoticeCard title="Email setup pending" message="New accounts and password recovery are paused until the TopicTrail administrator configures email codes. Existing users can log in with their password or keep studying in their current session." />;
}

type Props = { origin?: AuthOrigin; sessionId?: string; purpose?: 'signup' | 'recovery' };
/** StrictMode effect replay retains the flow; a real blur releases its temporary authority. */
function useEmailActionLifetime(cleanup: () => void) {
  const current = useRef(cleanup);
  useEffect(() => { current.current = cleanup; }, [cleanup]);
  const lifetime = useRef(0);
  useFocusEffect(useCallback(() => {
    const generation = ++lifetime.current;
    return () => { queueMicrotask(() => { if (lifetime.current === generation) current.current(); }); };
  }, []));
}
export function VerifyEmailScreen({ origin: supplied, sessionId, purpose = 'signup' }: Props) {
  const router = useRouter();
  const origin = authOrigin(supplied);
  const { gateway, state } = useAuth();
  const verification = gateway.verification;
  const [email, setEmail] = useState(''); const [code, setCode] = useState('');
  const [done, setDone] = useState(false); const [sent, setSent] = useState(false); const [attempted, setAttempted] = useState(false);
  const [pendingMessage, setPendingMessage] = useState('');
  const transferred = useRef(false);
  const task = useAuthTask(() => setCode(''));
  useEmailActionLifetime(() => { if (!transferred.current) verification?.cancelRecovery(); });
  const unavailable = gateway.emailCodesReady === false || !verification || state.status === 'loading' || state.status === 'unavailable';
  function submit() {
    setAttempted(true);
    if (emailError(email) || !/^\d{6,10}$/.test(code.trim()) || unavailable) return;
    setPendingMessage(purpose === 'recovery' ? 'Verifying recovery code…' : 'Verifying email code…');
    void task.run(() => purpose === 'recovery' ? verification.beginRecovery(email, code) : verification.verifyEmail(email, code), () => {
      setCode('');
      if (purpose === 'recovery') { transferred.current = true; goAuth(router, '/auth/update-password', origin, sessionId); }
      else setDone(true);
    });
  }
  function resend() {
    setAttempted(true); if (emailError(email) || unavailable) return;
    setPendingMessage('Requesting another code…');
    void task.run(() => purpose === 'recovery' ? gateway.sendPasswordReset(email) : verification.resendConfirmation(email), () => setSent(true));
  }
  return <AuthFrame announcement={done ? 'status' : 'off'} title={done ? 'Email verified' : purpose === 'recovery' ? 'Verify recovery code' : 'Verify your email'}
    description={gateway.emailCodesReady === false ? 'Return to log in with your existing account.' : done ? 'Log in with your email and password to continue.' : 'Enter the code from your latest email. Codes and passwords stay out of navigation links.'}
    busy={task.busy} backLabel="Back to log in" onBack={() => { setCode(''); verification?.cancelRecovery(); goAuth(router, '/auth/login', origin, sessionId); }}>
    <AuthAvailability />
    {gateway.emailCodesReady === false && <EmailSetupNotice />}
    {!!task.error && <TTNoticeCard type="error" title="Verification needs attention" message={task.error} />}
    <TTFeedback visuallyHidden message={task.busy ? pendingMessage : ''} />
    {done ? <TTButton label="Back to log in" onPress={() => goAuth(router, '/auth/login', origin, sessionId)} /> : <>
      <AuthField label="Email address" value={email} onChange={setEmail} placeholder="Enter your email" email disabled={task.busy || unavailable} error={attempted ? emailError(email) : undefined} />
      <AuthField label="Email code" value={code} onChange={setCode} placeholder="Code from email" oneTimeCode disabled={task.busy || unavailable}
        error={attempted && !/^\d{6,10}$/.test(code.trim()) ? 'Enter the code from your latest email.' : undefined} />
      <TTButton label="Verify code" isLoading={task.busy} disabled={unavailable} onPress={submit} />
      <TTButton label="Request another code" variant="ghost" disabled={task.busy || unavailable} onPress={resend} />
      {sent && !task.busy && !task.error && <TTNoticeCard announcement="status" title="Check your email" message="If the address is eligible, it will receive instructions. Check spam and wait before requesting again." />}
    </>}
  </AuthFrame>;
}

export function UpdatePasswordScreen({ origin: supplied, sessionId }: Props) {
  const router = useRouter();
  const origin = authOrigin(supplied);
  const { gateway } = useAuth();
  const verification = gateway.verification;
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState('');
  const [done, setDone] = useState(false); const [attempted, setAttempted] = useState(false);
  const clear = () => { setPassword(''); setConfirmation(''); };
  const task = useAuthTask(clear);
  useEmailActionLifetime(() => verification?.cancelRecovery());
  const ready = verification?.hasRecoverySession() ?? false;
  function submit() {
    setAttempted(true); if (!ready || !verification || !password || password !== confirmation) return;
    void task.run(() => verification.completeRecovery(password), () => { clear(); setDone(true); });
  }
  return <AuthFrame announcement={done ? 'status' : 'off'} title={done ? 'Password changed' : 'Choose a new password'}
    description={done ? 'Use your new password on the Login screen. This recovery flow has not signed you into a library.' : 'Use a long, unique password. The recovery session expires after ten minutes.'}
    busy={task.busy} backLabel="Back to log in" onBack={() => { clear(); verification?.cancelRecovery(); goAuth(router, '/auth/login', origin, sessionId); }}>
    {!!task.error && <TTNoticeCard type="error" title="Unable to change password" message={task.error} />}
    <TTFeedback visuallyHidden message={task.busy ? 'Changing password…' : ''} />
    {!ready && !done && <TTNoticeCard announcement="alert" title="Recovery verification required" message="Request a new recovery email and verify its code before changing your password." />}
    {ready && !done && <>
      <TTNoticeCard title="Recovering account" message={verification?.recoveryEmail() ?? 'Verified email account'} />
      <AuthField label="New password" value={password} onChange={setPassword} placeholder="Enter a new password" password newPassword disabled={task.busy} error={attempted && !password ? 'Enter a password.' : undefined} />
      <AuthField label="Confirm new password" value={confirmation} onChange={setConfirmation} placeholder="Re-enter your password" password newPassword disabled={task.busy}
        error={attempted && password !== confirmation ? 'Your passwords do not match.' : undefined} />
      <TTButton label="Change password" isLoading={task.busy} onPress={submit} />
    </>}
    <TTButton label="Back to log in" variant="ghost" disabled={task.busy} onPress={() => { clear(); verification?.cancelRecovery(); goAuth(router, '/auth/login', origin, sessionId); }} />
  </AuthFrame>;
}

export function EmailCallbackScreen() {
  const router = useRouter();
  const { gateway } = useAuth();
  const paused = gateway.emailCodesReady === false;
  return <AuthFrame title="Enter your email code" description={paused ? 'Return to log in with your existing account.' : 'Open the latest TopicTrail email and enter its code. You can also request a new code.'}
    busy={false} backLabel="Back to log in" onBack={() => goAuth(router, '/auth/login', 'welcome')}>
    {paused && <EmailSetupNotice />}
    <TTButton label="Enter verification code" disabled={paused} onPress={() => goAuth(router, '/auth/verify', 'welcome')} />
    <TTButton label="Enter recovery code" variant="ghost" disabled={paused} onPress={() => router.replace({ pathname: '/auth/verify', params: { origin: 'welcome', purpose: 'recovery' } })} />
  </AuthFrame>;
}
