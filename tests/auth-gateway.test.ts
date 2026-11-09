import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import type { AccountIdentity, AuthBackend, AuthState } from '../src/core/auth/types';

const identity: AccountIdentity = { uid: 'student-a', email: 'student@example.test', displayName: 'Student A', emailVerified: false };
class Backend implements AuthBackend {
  user: AccountIdentity | null = null;
  changed?: () => void;
  failed?: () => void;
  error?: { code: string; message: string };
  profileError = false;
  logoutError = false;
  created = 0;
  detached = false;
  credentials?: [string, string];
  wait?: Promise<void>;
  currentIdentity() { return this.user; }
  observe(changed: () => void, failed: () => void) { this.changed = changed; this.failed = failed; return () => { this.detached = true; }; }
  emit(user: AccountIdentity | null) { this.user = user; this.changed?.(); }
  async signIn(email: string, password: string) { this.credentials = [email, password]; await this.wait; if (this.error) throw this.error; this.emit(identity); }
  async createAccount() { if (this.error) throw this.error; this.created++; this.emit(identity); }
  async updateDisplayName(displayName: string) { if (this.profileError) throw Error('private profile detail'); this.user = { ...identity, displayName }; this.changed?.(); }
  async sendPasswordReset() { if (this.error) throw this.error; }
  async signOut() { if (this.logoutError) throw Error('private logout detail'); this.emit(null); }
}
async function setup() {
  assert.ok(existsSync('src/core/auth/gateway.ts'), 'Authentication gateway is not implemented');
  const { createAuthGateway } = await import('../src/core/auth/gateway');
  const backend = new Backend(); const gateway = createAuthGateway(backend);
  const states: AuthState[] = []; gateway.subscribe(state => states.push(state));
  backend.emit(null);
  return { backend, gateway, states };
}

test('auth observer hydrates guest then publishes actual provider identity', async () => {
  const { backend, gateway, states } = await setup();
  assert.deepEqual(states.slice(0, 2), [{ status: 'loading' }, { status: 'guest' }]);
  backend.emit(identity); assert.deepEqual(gateway.getSnapshot(), { status: 'account', account: identity }); gateway.dispose();
});
test('sign-in trims email but preserves password bytes and exposes confirmed identity', async () => {
  const { backend, gateway } = await setup(); await gateway.signIn(' student@example.test ', '  pass phrase  ');
  assert.deepEqual(backend.credentials, ['student@example.test', '  pass phrase  ']);
  assert.equal(gateway.getSnapshot().status, 'account'); gateway.dispose();
});
test('credential errors are generic and never expose raw provider details', async () => {
  const { backend, gateway } = await setup(); backend.error = { code: 'auth/wrong-password', message: 'private-token-and-email' };
  await assert.rejects(gateway.signIn('student@example.test', 'bad'), error => error instanceof Error && 'code' in error && error.code === 'invalid_credentials' && !error.message.includes('private-token'));
  assert.equal(gateway.getSnapshot().status, 'guest'); gateway.dispose();
});
test('registration suppresses automatic provider sign-in and finishes signed out', async () => {
  const { backend, gateway, states } = await setup(); await gateway.register(' Student A ', 'student@example.test', 'pass phrase');
  assert.equal(backend.created, 1); assert.equal(backend.user, null);
  assert.ok(states.every(state => state.status !== 'account')); assert.deepEqual(gateway.getSnapshot(), { status: 'guest' }); gateway.dispose();
});
test('registration profile failure reports existing account and still signs out', async () => {
  const { backend, gateway, states } = await setup(); backend.profileError = true;
  await assert.rejects(gateway.register('Student A', 'student@example.test', 'pass phrase'), error => error instanceof Error && 'code' in error && error.code === 'account_created');
  assert.equal(backend.created, 1); assert.equal(backend.user, null); assert.ok(states.every(state => state.status !== 'account')); gateway.dispose();
});
test('registration cleanup failure fails closed until explicit sign-out succeeds', async () => {
  const { backend, gateway, states } = await setup(); backend.logoutError = true;
  await assert.rejects(gateway.register('Student A', 'student@example.test', 'pass phrase'), error => error instanceof Error && 'code' in error && error.code === 'account_created');
  assert.equal(gateway.getSnapshot().status, 'unavailable'); backend.changed?.();
  assert.equal(gateway.getSnapshot().status, 'unavailable'); assert.ok(states.every(state => state.status !== 'account'));
  backend.logoutError = false; await gateway.signOut(); assert.equal(gateway.getSnapshot().status, 'guest'); gateway.dispose();
});
test('registration failure before creation reports network failure without a false account-created result', async () => {
  const { backend, gateway } = await setup(); backend.error = { code: 'auth/network-request-failed', message: 'private response' };
  await assert.rejects(gateway.register('Student A', 'student@example.test', 'pass phrase'), error => error instanceof Error && 'code' in error && error.code === 'network');
  assert.equal(backend.created, 0); assert.equal(gateway.getSnapshot().status, 'guest'); gateway.dispose();
});
test('registering over an existing signed-in session does not replace its account', async () => {
  const { backend, gateway } = await setup(); backend.emit(identity);
  await assert.rejects(gateway.register('Other', 'other@example.test', 'pass phrase'), error => error instanceof Error && 'code' in error && error.code === 'already_signed_in');
  assert.equal(backend.created, 0); assert.equal(backend.user?.uid, 'student-a'); gateway.dispose();
});
test('password reset does not disclose whether an account exists', async () => {
  const { backend, gateway } = await setup(); await gateway.sendPasswordReset('student@example.test');
  backend.error = { code: 'auth/user-not-found', message: 'private account information' };
  await gateway.sendPasswordReset('missing@example.test'); assert.equal(gateway.getSnapshot().status, 'guest'); gateway.dispose();
});
test('concurrent auth mutations reject the second operation rather than racing', async () => {
  const { backend, gateway } = await setup(); let resolve!: () => void;
  backend.wait = new Promise<void>(done => { resolve = done; });
  const pending = gateway.signIn('student@example.test', 'pass phrase');
  await assert.rejects(gateway.signOut(), error => error instanceof Error && 'code' in error && error.code === 'busy');
  resolve(); await pending; assert.equal(gateway.getSnapshot().status, 'account'); gateway.dispose();
});
test('failed sign-out keeps actual signed-in identity instead of claiming guest', async () => {
  const { backend, gateway } = await setup(); backend.emit(identity); backend.logoutError = true;
  await assert.rejects(gateway.signOut()); assert.equal(gateway.getSnapshot().status, 'account'); gateway.dispose();
});
test('observer failure reports unavailable instead of inventing an account', async () => {
  const { backend, gateway } = await setup(); backend.failed?.(); assert.equal(gateway.getSnapshot().status, 'unavailable'); gateway.dispose();
});
test('late observer notifications cannot resurrect registration automatic sign-in', async () => {
  const { backend, gateway } = await setup(); await gateway.register('Student A', 'student@example.test', 'pass phrase');
  backend.changed?.(); assert.equal(gateway.getSnapshot().status, 'guest'); gateway.dispose();
});
test('disposed gateway detaches and rejects further operations without side effects', async () => {
  const { backend, gateway, states } = await setup(); gateway.dispose(); assert.equal(backend.detached, true);
  const count = states.length; backend.emit(identity); assert.equal(states.length, count);
  await assert.rejects(gateway.signIn('student@example.test', 'pass phrase'), error => error instanceof Error && 'code' in error && error.code === 'unavailable');
  assert.equal(backend.credentials, undefined);
});
