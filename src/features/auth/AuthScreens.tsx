import React, { useState } from 'react';
import { Modal, Text, View } from 'react-native';
import { router } from 'expo-router';
import { TTButton, TTCard, TTFeedback, TTNoticeCard } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useTheme } from '../../core/theme/ThemeContext';
import { useAuth } from './AuthContext';
import { AuthField } from './AuthField';
import { AuthAccessButton } from './AuthAccessLayout';
import { AuthProfileDetails, AuthProfileFrame } from './AuthProfile';
import {useUploadContinuation} from '../upload/UploadSessionContext';
import { AuthAvailability, AuthFrame, AuthInfo, authErrorCode, authOrigin, emailError, goAuth, leaveAuth, useAuthTask, type AuthOrigin } from './AuthForm';

type OriginProps = { origin?: AuthOrigin; sessionId?: string };
function UploadContinuationNotice({origin,matching}: {origin:AuthOrigin;matching:boolean}) {
  return origin === 'upload' && !matching ? <TTNoticeCard title="Upload selection no longer available" message="Return to Upload to review your current selection or choose your file again." /> : null;
}
function SignedInNotice({ busy }: { busy: boolean }) {
  return <><TTNoticeCard announcement="status" title="You are signed in" message="Open Settings to view your account or log out." />
    <AuthAccessButton label="Open Settings" disabled={busy} onPress={() => router.replace('/(tabs)/settings')} /></>;
}
export function LoginScreen({ origin: supplied, sessionId }: OriginProps) {
  const origin = authOrigin(supplied);
  const matching = useUploadContinuation(sessionId);
  const { gateway, state } = useAuth();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [attempted, setAttempted] = useState(false);
  const task = useAuthTask(() => setPassword(''));
  const unavailable = state.status !== 'guest';
  function submit() {
    setAttempted(true);
    if (emailError(email) || !password || unavailable) return;
    void task.run(() => gateway.signIn(email.trim(), password), () => {
      setPassword('');
      // A resolved operation alone is insufficient: only a real account snapshot grants entry.
      if (gateway.getSnapshot().status !== 'account') { task.setError('Sign-in could not be confirmed. Please try again.'); return; }
      router.replace(origin === 'upload' ? '/upload' : origin === 'settings' ? '/auth/profile' : '/(tabs)/home');
    });
  }
  return <AuthFrame presentation="access" title="Welcome back" description="Ready to explore your next topic?" busy={task.busy}
    backLabel={origin === 'upload' ? 'Back to Upload' : origin === 'settings' ? 'Back to Settings' : 'Back to Welcome'} onBack={() => { setPassword(''); leaveAuth(origin); }}>
    <UploadContinuationNotice origin={origin} matching={matching} />
    <AuthAvailability />
    {state.status === 'account' ? <SignedInNotice busy={task.busy} /> : <>
      {!!task.error && <TTNoticeCard type="error" title="Unable to log in" message={task.error} />}
      <AuthField label="Email address" value={email} onChange={setEmail} placeholder="Enter your email" email disabled={task.busy || unavailable} error={attempted ? emailError(email) : undefined} />
      <AuthField label="Password" value={password} onChange={setPassword} placeholder="Enter your password" password disabled={task.busy || unavailable} error={attempted && !password ? 'Enter your password.' : undefined} />
      <AuthAccessButton label="Forgot password?" variant="ghost" disabled={task.busy} onPress={() => { setPassword(''); goAuth('/auth/recovery', origin, sessionId); }} />
      <AuthAccessButton label="Log in" semanticLabel={task.busy ? 'Logging in' : 'Log in'} isLoading={task.busy} disabled={unavailable} onPress={submit} />
      <AuthPendingStatus message={task.busy ? 'Logging in…' : ''} />
      <AuthAccessButton label="Create account" variant="ghost" disabled={task.busy} onPress={() => { setPassword(''); goAuth('/auth/register', origin, sessionId); }} />
      {gateway.verification && <AuthAccessButton label="Verify email" variant="ghost" disabled={task.busy} onPress={() => { setPassword(''); goAuth('/auth/verify', origin, sessionId); }} />}
    </>}
  </AuthFrame>;
}
export function RegistrationScreen({ origin: supplied, sessionId }: OriginProps) {
  const origin = authOrigin(supplied);
  const matching = useUploadContinuation(sessionId);
  const { colors } = useTheme(); const { gateway, state, recordAccountCreated } = useAuth();
  const [name, setName] = useState(''); const [email, setEmail] = useState('');
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState('');
  const [attempted, setAttempted] = useState(false); const [created, setCreated] = useState(false);
  const clear = () => { setPassword(''); setConfirmation(''); };
  const task = useAuthTask(clear);
  const unavailable = state.status !== 'guest';
  function toLogin() {
    clear();
    if (created) { void task.run(() => gateway.signOut(), () => {
      if (gateway.getSnapshot().status !== 'guest') { task.setError('Sign-out could not be confirmed. Please try again.'); return; }
      goAuth('/auth/login', origin, sessionId);
    }); }
    else goAuth('/auth/login', origin, sessionId);
  }
  function submit() {
    setAttempted(true);
    if (!name.trim() || emailError(email) || !password || !confirmation || password !== confirmation || unavailable || created) return;
    void task.run(() => gateway.register(name.trim(), email.trim(), password), () => {
      clear();
      if (gateway.getSnapshot().status !== 'guest') { setCreated(true); task.setError('Your account was created, but sign-out could not be confirmed. Continue to log in to retry sign-out.'); return; }
      recordAccountCreated(); goAuth('/auth/created', origin, sessionId);
    }, error => { if (authErrorCode(error) === 'account_created') { setCreated(true); clear(); } });
  }
  return <AuthFrame presentation="access" title="Create your account" description="Start exploring your syllabus, one topic at a time." busy={task.busy} backLabel="Back to log in" onBack={toLogin}>
    <UploadContinuationNotice origin={origin} matching={matching} />
    <AuthAvailability />
    {state.status === 'account' && !created ? <SignedInNotice busy={task.busy} /> : <>
      {created ? <TTNoticeCard title="Your account was created" message="Setup did not finish completely. Do not create it again. Continue to log in to finish signing out, then use your new email and password. If your name was not saved, your email will be shown." />
        : !!task.error && <TTNoticeCard type="error" title="Unable to create account" message={task.error} />}
      {created && !!task.error && <TTNoticeCard type="error" title="Setup needs attention" message={task.error} />}
      <AuthField label="Full name" value={name} onChange={setName} placeholder="Enter your full name" disabled={task.busy || unavailable || created} error={attempted && !name.trim() ? 'Enter your full name.' : undefined} />
      <AuthField label="Email address" value={email} onChange={setEmail} placeholder="Enter your email" email disabled={task.busy || unavailable || created} error={attempted ? emailError(email) : undefined} />
      <AuthField label="Password" value={password} onChange={setPassword} placeholder="Create a password" password newPassword disabled={task.busy || unavailable || created} error={!created && attempted && !password ? 'Enter a password.' : undefined} />
      <AuthField label="Confirm password" value={confirmation} onChange={setConfirmation} placeholder="Re-enter your password" password newPassword disabled={task.busy || unavailable || created}
        error={!created && attempted ? !confirmation ? 'Confirm your password.' : password !== confirmation ? 'Your passwords do not match.' : undefined : undefined} />
      <View style={{ gap: 8 }}><Text style={[TTTypography.small, { color: colors.muted }]}>Choose a long, unique password or passphrase.</Text>
        <Text style={[TTTypography.small, { color: colors.muted }]}>Avoid your name, email address and passwords you use elsewhere.</Text></View>
      <AuthAccessButton label="Create account" semanticLabel={task.busy && !created ? 'Creating account' : 'Create account'} isLoading={task.busy && !created} disabled={unavailable || created} onPress={submit} />
      <AuthPendingStatus message={task.busy ? created ? 'Finishing sign-out…' : 'Creating account…' : ''} />
      {created ? <AuthAccessButton label="Continue to log in" isLoading={task.busy} onPress={toLogin} /> : <AuthAccessButton label="Already have an account? Log in" variant="ghost" disabled={task.busy} onPress={toLogin} />}
    </>}
  </AuthFrame>;
}
function AuthPendingStatus({ message }: { message: string }) {
  const { colors } = useTheme();
  return <TTFeedback testID="auth-access-pending" message={message} style={[TTTypography.small, { color: colors.muted }]} />;
}
export function AccountCreatedScreen({ origin: supplied, sessionId }: OriginProps) {
  const origin = authOrigin(supplied);
  const matching = useUploadContinuation(sessionId);
  const { registrationCreatedAt, clearAccountCreated } = useAuth();
  const [openedAt] = useState(Date.now);
  // This receipt exists only after a confirmed successful registration; it is never a route parameter.
  const confirmed = registrationCreatedAt !== null && openedAt - registrationCreatedAt < 10 * 60 * 1000;
  function back() { clearAccountCreated(); goAuth('/auth/login', origin, sessionId); }
  return <AuthFrame announcement={confirmed ? 'status' : 'alert'} title={confirmed ? 'Check your email' : 'Account confirmation unavailable'}
    description={confirmed ? 'Verify your email before logging in. A successful request does not confirm email delivery.' : 'This screen has no recent registration request. Return to log in or create an account.'} backLabel="Back to log in" onBack={back}>
    <UploadContinuationNotice origin={origin} matching={matching} />
    {confirmed && <><TTNoticeCard title="Email confirmation required" message="If this address can register, check its inbox and spam folder. Existing accounts can log in or request password recovery." />
      <TTButton label="Enter verification code" onPress={() => goAuth('/auth/verify', origin, sessionId)} /></>}
    <TTButton label="Back to log in" onPress={back} />
  </AuthFrame>;
}
export function RecoveryScreen({ origin: supplied, sessionId }: OriginProps) {
  const origin = authOrigin(supplied);
  const matching = useUploadContinuation(sessionId);
  const { colors } = useTheme(); const { gateway, state } = useAuth();
  const [email, setEmail] = useState(''); const [attempted, setAttempted] = useState(false); const [done, setDone] = useState(false);
  const task = useAuthTask();
  const unavailable = state.status === 'loading' || state.status === 'unavailable';
  function submit() {
    setAttempted(true); if (emailError(email) || unavailable) return;
    void task.run(() => gateway.sendPasswordReset(email.trim()), () => setDone(true));
  }
  return <AuthFrame announcement={done && !task.busy && !task.error ? 'status' : 'off'} title={done ? 'Check your email' : 'Forgot password?'} description={done ? "If an account uses this email, you'll receive password reset instructions." : 'Enter your email to request password reset instructions.'}
    busy={task.busy} backLabel="Back to log in" onBack={() => goAuth('/auth/login', origin, sessionId)}>
    <UploadContinuationNotice origin={origin} matching={matching} />
    <AuthAvailability />
    {!!task.error && <TTNoticeCard type="error" title="Unable to request reset" message={task.error} />}
    <TTFeedback visuallyHidden message={task.busy ? 'Requesting reset link…' : ''} />
    {done ? <><AuthInfo message="Check your inbox and spam folder." /><Text style={[TTTypography.bodyStrong, { color: colors.ink }]}>{email.trim()}</Text>
      {gateway.verification && <TTButton label="Enter recovery code" disabled={task.busy} onPress={() => router.replace({ pathname: '/auth/verify', params: { origin, purpose: 'recovery', ...(origin === 'upload' && sessionId ? { sessionId } : {}) } })} />}
      <TTButton label="Back to log in" disabled={task.busy} onPress={() => goAuth('/auth/login', origin, sessionId)} />
      <TTButton label="Request another link" variant="ghost" isLoading={task.busy} disabled={unavailable} onPress={submit} />
    </> : <>
      <AuthField label="Email address" value={email} onChange={setEmail} placeholder="Enter your email" email disabled={task.busy || unavailable} error={attempted ? emailError(email) : undefined} />
      <TTButton label="Send reset link" semanticLabel={task.busy ? 'Requesting reset link' : 'Send reset link'} isLoading={task.busy} disabled={unavailable} onPress={submit} />
      <TTButton label="Back to log in" variant="ghost" disabled={task.busy} onPress={() => goAuth('/auth/login', origin, sessionId)} />
    </>}
  </AuthFrame>;
}
export function ProfileScreen() {
  const { colors } = useTheme(); const { gateway, state } = useAuth();
  const [logoutVisible, setLogoutVisible] = useState(false); const task = useAuthTask();
  function confirm() {
    void task.run(() => gateway.signOut(), () => {
      if (gateway.getSnapshot().status !== 'guest') { task.setError('Sign-out could not be confirmed. Please try again.'); return; }
      setLogoutVisible(false); goAuth('/auth/login', 'settings');
    });
  }
  const account = state.status === 'account' ? state.account : null;
  const initials = (account?.displayName || account?.email || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  return <AuthProfileFrame busy={task.busy} onBack={() => router.replace('/(tabs)/settings')}>
    <AuthAvailability />
    {account ? <AuthProfileDetails account={account} initials={initials} busy={task.busy}
      onResetPassword={() => goAuth('/auth/recovery', 'settings')}
      onLogout={() => { task.setError(''); setLogoutVisible(true); }} />
      : state.status === 'guest' ? <><TTNoticeCard title="You are not signed in" message="Log in to view your account details." /><TTButton label="Log in" disabled={task.busy} onPress={() => goAuth('/auth/login', 'settings')} /></> : null}
    <Modal visible={logoutVisible} transparent animationType="fade" onRequestClose={() => { if (!task.busy) setLogoutVisible(false); }}>
      <View style={{ flex: 1, backgroundColor: 'rgba(11,18,32,0.56)', justifyContent: 'center', alignItems: 'center', padding: 16 }}>
        <TTCard padding={24} borderRadius={24} style={{ width: '100%', maxWidth: 480, gap: 16 }}>
          <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink }]}>Log out of TopicTrail?</Text>
          <Text style={[TTTypography.body, { color: colors.muted }]}>Your syllabi and saved links will stay on this device.</Text>
          {!!task.error && <TTNoticeCard type="error" title="Unable to log out" message={task.error} />}
          <TTFeedback visuallyHidden message={task.busy ? 'Logging out…' : ''} />
          <TTButton label="Log out" semanticLabel={task.busy ? 'Logging out' : 'Log out'} isLoading={task.busy} onPress={confirm} />
          <TTButton label="Cancel" variant="secondary" disabled={task.busy} onPress={() => setLogoutVisible(false)} />
        </TTCard>
      </View>
    </Modal>
  </AuthProfileFrame>;
}
