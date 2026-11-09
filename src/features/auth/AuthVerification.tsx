import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { TTButton, TTFeedback, TTNoticeCard } from '../../components';
import { useAuth } from './AuthContext';
import { AuthField } from './AuthField';
import { AuthAvailability, AuthFrame, authOrigin, emailError, goAuth, useAuthTask, type AuthOrigin } from './AuthForm';
import { getEmailCallback, clearEmailCallback, getEmailCallbackRevision, subscribeEmailCallback } from '../../core/auth/email_callback';

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
  const origin = authOrigin(supplied);
  const { gateway, state } = useAuth();
  const verification = gateway.verification;
  const [email, setEmail] = useState(''); const [code, setCode] = useState('');
  const [done, setDone] = useState(false); const [sent, setSent] = useState(false); const [attempted, setAttempted] = useState(false);
  const [pendingMessage, setPendingMessage] = useState('');
  const transferred = useRef(false);
  const task = useAuthTask(() => setCode(''));
  useEmailActionLifetime(() => { if (!transferred.current) verification?.cancelRecovery(); });
  const unavailable = !verification || state.status === 'loading' || state.status === 'unavailable';
  function submit() {
    setAttempted(true);
    if (emailError(email) || !/^\d{6,10}$/.test(code.trim()) || unavailable) return;
    setPendingMessage(purpose === 'recovery' ? 'Verifying recovery code…' : 'Verifying email code…');
    void task.run(() => purpose === 'recovery' ? verification.beginRecovery(email, code) : verification.verifyEmail(email, code), () => {
      setCode('');
      if (purpose === 'recovery') { transferred.current = true; goAuth('/auth/update-password', origin, sessionId); }
      else setDone(true);
    });
  }
  function resend() {
    setAttempted(true); if (emailError(email) || unavailable) return;
    setPendingMessage('Requesting another code…');
    void task.run(() => purpose === 'recovery' ? gateway.sendPasswordReset(email) : verification.resendConfirmation(email), () => setSent(true));
  }
  return <AuthFrame announcement={done ? 'status' : 'off'} title={done ? 'Email verified' : purpose === 'recovery' ? 'Verify recovery code' : 'Verify your email'}
    description={done ? 'Log in with your email and password to continue.' : 'Enter the code from your latest email. Codes and passwords stay out of navigation links.'}
    busy={task.busy} backLabel="Back to log in" onBack={() => { setCode(''); verification?.cancelRecovery(); goAuth('/auth/login', origin, sessionId); }}>
    <AuthAvailability />
    {!!task.error && <TTNoticeCard type="error" title="Verification needs attention" message={task.error} />}
    <TTFeedback visuallyHidden message={task.busy ? pendingMessage : ''} />
    {done ? <TTButton label="Back to log in" onPress={() => goAuth('/auth/login', origin, sessionId)} /> : <>
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
    busy={task.busy} backLabel="Back to log in" onBack={() => { clear(); verification?.cancelRecovery(); goAuth('/auth/login', origin, sessionId); }}>
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
    <TTButton label="Back to log in" variant="ghost" disabled={task.busy} onPress={() => { clear(); verification?.cancelRecovery(); goAuth('/auth/login', origin, sessionId); }} />
  </AuthFrame>;
}

export function EmailCallbackScreen() {
  const revision = useSyncExternalStore(subscribeEmailCallback, getEmailCallbackRevision, getEmailCallbackRevision);
  return <EmailCallbackAction key={revision} revision={revision} />;
}
function EmailCallbackAction({ revision }: { revision: number }) {
  const { gateway } = useAuth();
  const [callback, setCallback] = useState(getEmailCallback);
  const [done, setDone] = useState(false);
  const transferred = useRef(false);
  const task = useAuthTask();
  useEmailActionLifetime(() => { clearEmailCallback(revision); setCallback(undefined); if (!transferred.current) gateway.verification?.cancelRecovery(); });
  function verify() {
    if (!callback?.tokenHash || !gateway.verification || getEmailCallbackRevision() !== revision) return;
    void task.run(() => gateway.verification!.verifyLink(callback.tokenHash!, callback.purpose), () => {
      if (getEmailCallbackRevision() !== revision) { gateway.verification?.cancelRecovery(); return; }
      clearEmailCallback(revision); setCallback(undefined);
      if (callback.purpose === 'recovery') { transferred.current = true; goAuth('/auth/update-password', 'welcome'); }
      else setDone(true);
    });
  }
  return <AuthFrame announcement={done ? 'status' : 'off'} title={done ? 'Email verified' : 'Email action'} description={done ? 'Log in with your email and password.'
    : callback?.tokenHash ? 'Continue to verify this email action. It will not sign you into a library.'
      : 'If you confirmed your email, return to log in. For password recovery, enter the code from your email.'}
    busy={task.busy} backLabel="Back to log in" onBack={() => { clearEmailCallback(); goAuth('/auth/login', 'welcome'); }}>
    {!!task.error && <TTNoticeCard type="error" title="Email action needs attention" message={task.error} />}
    <TTFeedback visuallyHidden message={task.busy ? 'Verifying email action…' : ''} />
    {!!callback?.tokenHash && !done && <TTButton label="Continue email action" isLoading={task.busy} disabled={!gateway.verification} onPress={verify} />}
    {!done && <TTButton label="Enter email code" disabled={task.busy} onPress={() => { clearEmailCallback(); router.replace({ pathname: '/auth/verify', params: { origin: 'welcome', purpose: callback?.purpose ?? 'signup' } }); }} />}
    <TTButton label="Back to log in" variant="ghost" disabled={task.busy} onPress={() => { clearEmailCallback(); goAuth('/auth/login', 'welcome'); }} />
  </AuthFrame>;
}
