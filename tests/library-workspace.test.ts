import assert from 'node:assert/strict';
import test from 'node:test';
import { accountNamespace, guestNamespace, LibraryWorkspace, workspaceForAuthentication, WorkspaceChangedError } from '../src/core/services/library_workspace';
import type { AccountIdentity } from '../src/core/auth/types';

const project = 'abcdefghijklmnopqrst';
const guest = '00000000-0000-4000-8000-000000000001';
const a = '00000000-0000-4000-8000-000000000002';
const b = '00000000-0000-4000-8000-000000000003';
const account: AccountIdentity = { uid: a, email: 'same@example.test', displayName: 'Same', emailVerified: true, projectNamespace: project };

test('guest and accounts have disjoint canonical namespaces including the Supabase project identity', () => {
  const keys = [guestNamespace(guest).key, accountNamespace(project, a).key, accountNamespace(project, b).key, accountNamespace('tsrqponmlkjihgfedcba', a).key];
  assert.equal(new Set(keys).size, 4);
  assert.equal(keys[0], `guest/${guest}`); assert.equal(keys[1], `account/${project}/${a}`);
  assert.throws(() => guestNamespace('legacy-unknown'), WorkspaceChangedError);
  assert.throws(() => accountNamespace('../shared', a), WorkspaceChangedError);
  assert.throws(() => accountNamespace(project, a + '/../../guest'), WorkspaceChangedError);
});
test('unavailable/loading/unverified/foreign-project authentication cannot open the last or guest library implicitly', () => {
  assert.equal(workspaceForAuthentication({ status: 'loading' }, project, guest), null);
  assert.equal(workspaceForAuthentication({ status: 'unavailable' }, project, guest), null);
  assert.equal(workspaceForAuthentication({ status: 'guest' }, project, null), null);
  assert.equal(workspaceForAuthentication({ status: 'account', account: { ...account, emailVerified: false } }, project, guest), null);
  assert.equal(workspaceForAuthentication({ status: 'account', account: { ...account, projectNamespace: undefined } }, project, guest), null);
  assert.equal(workspaceForAuthentication({ status: 'account', account }, 'tsrqponmlkjihgfedcba', guest), null);
  assert.equal(workspaceForAuthentication({ status: 'account', account }, project, guest)?.key, `account/${project}/${a}`);
  assert.equal(workspaceForAuthentication({ status: 'guest' }, project, guest)?.key, `guest/${guest}`);
});
test('a late A read is aborted/rejected after switching to B without publishing its private result', async () => {
  const workspace = new LibraryWorkspace(); workspace.select(accountNamespace(project, a));
  const lease = workspace.capture(); let resolve!: (value: string) => void; let published = false;
  const read = workspace.read(lease, () => new Promise<string>(done => { resolve = done; })).then(value => { published = true; return value; });
  workspace.select(accountNamespace(project, b)); assert.equal(lease.signal.aborted, true); resolve('synthetic A content');
  await assert.rejects(read, WorkspaceChangedError); assert.equal(published, false);
  assert.equal(workspace.getSnapshot().namespace?.key, accountNamespace(project, b).key);
});
test('A to B to A and a new runtime cannot reuse a stale or forged operation lease', () => {
  const workspace = new LibraryWorkspace(); workspace.select(accountNamespace(project, a)); const old = workspace.capture();
  workspace.select(accountNamespace(project, b)); workspace.select(accountNamespace(project, a));
  assert.throws(() => workspace.assertCurrent(old), WorkspaceChangedError);
  const current = workspace.capture(); workspace.assertCurrent(current);
  assert.throws(() => workspace.assertCurrent({ ...current }), WorkspaceChangedError);
  const restarted = new LibraryWorkspace(); restarted.select(accountNamespace(project, a));
  assert.throws(() => restarted.assertCurrent(current), WorkspaceChangedError);
});
test('same identity refresh retains current reads, while logout/disposal closes them without adopting guest data', async () => {
  const workspace = new LibraryWorkspace(); workspace.select(accountNamespace(project, a)); const lease = workspace.capture();
  workspace.select(accountNamespace(project, a)); assert.equal(lease.signal.aborted, false);
  assert.equal(await workspace.read(lease, async () => 'synthetic A'), 'synthetic A');
  workspace.select(guestNamespace(guest)); assert.throws(() => workspace.assertCurrent(lease), WorkspaceChangedError);
  const guestLease = workspace.capture(); workspace.dispose(); assert.throws(() => workspace.assertCurrent(guestLease), WorkspaceChangedError);
  assert.throws(() => workspace.capture(), WorkspaceChangedError);
});
