import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { jsx } from 'react/jsx-runtime';
import type { CloudSyncSnapshot } from '../src/core/services/cloud/engine';
import type { CloudLibraryRuntime } from '../src/core/services/cloud/runtime';
import { ImportResult, type ImportAttempt } from '../src/core/services/document_import_contract';
import { CloudRuntimeContext } from '../src/features/library/CloudLibraryContext';
import { UploadSessionProvider, useUploadContinuation, useUploadSession } from '../src/features/upload/UploadSessionContext';
import { UploadSession, type UploadDependencies } from '../src/features/upload/upload_session';

const project = 'abcdefghijklmnopqrst';
const uidA = '10000000-2000-3000-4000-500000000000';
const uidB = '10000000-2000-3000-4000-500000000001';
const actorA = { kind: 'account' as const, uid: uidA };

let dom: JSDOM;
const previous = new Map<string, PropertyDescriptor | undefined>();

before(() => {
  dom = new JSDOM('<!doctype html><body></body>');
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

after(() => {
  dom?.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function snapshot(phase: CloudSyncSnapshot['phase'], epoch: number, uid?: string): CloudSyncSnapshot {
  return { identity: uid ? { project, uid } : null, key: uid ? project + '/' + uid : null,
    phase, epoch, revision: epoch, message: '', pending: 0, lastSyncedAt: null };
}

function asset(name: string) { return { uri: 'file:///' + name, name, lastModified: 0 }; }

function session(pick: UploadDependencies['pick'], result = new ImportResult(false, undefined, 'Retry this upload.', false, 'retry')) {
  const discards: string[] = [];
  const imports: ImportAttempt[] = [];
  let picks = 0;
  const owner = new UploadSession({
    policy: 'disabled',
    pick: () => { picks++; return pick(); },
    discard: uri => { discards.push(uri); },
    importFile: async (_uri, _name, attempt) => { imports.push(attempt); return result; },
    allowance: async () => ({ kind: 'disabled' }),
    lookup: async () => ({ kind: 'uncommitted' }),
  });
  return { owner, discards, imports, picks: () => picks };
}

interface RenderedUpload {
  sessionId: string | null;
  attemptId: string | null;
  asset: string | null;
  result: string | null;
  picking: boolean;
  continuation: boolean;
}

function UploadProbe({ continuationId }: { continuationId?: string }) {
  const { state } = useUploadSession();
  const continuation = useUploadContinuation(continuationId);
  const view: RenderedUpload = {
    sessionId: state.sessionId,
    attemptId: state.attemptId,
    asset: state.asset?.name ?? null,
    result: state.result?.errorMessage ?? null,
    picking: state.picking,
    continuation,
  };
  return React.createElement('output', null, JSON.stringify(view));
}

interface ProviderHarness {
  show(owner: UploadSession, continuationId?: string): Promise<void>;
  publish(next: CloudSyncSnapshot): Promise<void>;
  view(): RenderedUpload;
}

async function withProvider(initial: CloudSyncSnapshot, run: (ui: ProviderHarness) => Promise<void>) {
  const { createRoot } = await import('react-dom/client');
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  let current = initial;
  const listeners = new Set<() => void>();
  const store: Pick<CloudLibraryRuntime, 'getSnapshot' | 'subscribe'> = {
    getSnapshot: () => current,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  try {
    await run({
      show: (owner, continuationId) => act(async () => {
        const children = React.createElement(UploadProbe, { continuationId });
        const provider = jsx(UploadSessionProvider, { owner, children });
        root.render(React.createElement(CloudRuntimeContext.Provider, { value: store as CloudLibraryRuntime }, provider));
      }),
      publish: next => act(async () => {
        current = next;
        listeners.forEach(listener => listener());
      }),
      view: () => JSON.parse(host.querySelector('output')!.textContent!) as RenderedUpload,
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

test('a guest upload keeps the selected file and continuation when its user signs in', async () => {
  const guest = session(async () => asset('guest-syllabus.pdf'));
  const alternate = session(async () => null);
  await withProvider(snapshot('guest', 0), async ui => {
    await ui.show(guest.owner);
    await act(async () => guest.owner.pick({ kind: 'guest' }));
    const selected = ui.view();
    assert.equal(selected.asset, 'guest-syllabus.pdf');
    assert.ok(selected.sessionId && selected.attemptId);
    // A fresh injected owner detects an unintended remount on sign-in.
    await ui.show(alternate.owner, selected.sessionId);
    await ui.publish(snapshot('ready', 1, uidA));
    assert.deepEqual(ui.view(), { ...selected, continuation: true });
    assert.deepEqual(guest.discards, []);
    assert.deepEqual(guest.imports, []);
    await act(async () => { await guest.owner.submit(actorA); });
    assert.deepEqual(guest.imports, [{ attemptId: selected.attemptId, actor: actorA }]);
  });
});

test('switching accounts clears and disposes the previous upload selection and result', async () => {
  const a = session(async () => asset('account-a.pdf'));
  const b = session(async () => asset('account-b.pdf'));
  await withProvider(snapshot('ready', 1, uidA), async ui => {
    await ui.show(a.owner);
    await act(async () => { await a.owner.pick(actorA); await a.owner.submit(actorA); });
    const selected = ui.view();
    assert.equal(selected.asset, 'account-a.pdf');
    assert.equal(selected.result, 'Retry this upload.');
    assert.ok(selected.sessionId);
    await ui.show(b.owner, selected.sessionId);
    await ui.publish(snapshot('ready', 2, uidB));
    assert.deepEqual(ui.view(), { sessionId: null, attemptId: null, asset: null, result: null, picking: false, continuation: false });
    assert.deepEqual(a.discards, ['file:///account-a.pdf']);
    assert.equal(a.owner.getSnapshot().result, undefined);
    await a.owner.pick(actorA);
    assert.equal(a.picks(), 1, 'the retired owner cannot open another picker');
    await act(async () => b.owner.pick({ kind: 'account', uid: uidB }));
    assert.equal(ui.view().asset, 'account-b.pdf');
  });
});

test('losing the active account releases its selection and discards a late picker result', async () => {
  const late = Promise.withResolvers<ReturnType<typeof asset>>();
  let pickCount = 0;
  const a = session(() => ++pickCount === 1 ? Promise.resolve(asset('account-a.pdf')) : late.promise);
  const unavailable = session(async () => null);
  await withProvider(snapshot('ready', 1, uidA), async ui => {
    await ui.show(a.owner);
    await act(async () => { await a.owner.pick(actorA); await a.owner.submit(actorA); });
    const selected = ui.view();
    assert.ok(selected.sessionId);
    await ui.show(unavailable.owner, selected.sessionId);
    let picking!: Promise<void>;
    await act(async () => { picking = a.owner.pick(actorA); });
    assert.equal(ui.view().picking, true);
    assert.equal(ui.view().result, 'Retry this upload.');
    await ui.publish(snapshot('unavailable', 2));
    const cleared = { sessionId: null, attemptId: null, asset: null, result: null, picking: false, continuation: false };
    assert.deepEqual(ui.view(), cleared);
    assert.deepEqual(a.discards, ['file:///account-a.pdf']);
    await act(async () => { late.resolve(asset('late-account-a.pdf')); await picking; });
    assert.deepEqual(ui.view(), cleared);
    assert.equal(a.owner.getSnapshot().asset, null);
    assert.deepEqual(a.discards, ['file:///account-a.pdf', 'file:///late-account-a.pdf']);
  });
});
