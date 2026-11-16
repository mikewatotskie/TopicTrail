import assert from 'node:assert/strict';
import test from 'node:test';
import { createOfflineOcr } from '../src/features/reader/ocr_worker';

class FakeWorker {
  static instances: FakeWorker[] = [];
  static afterResponse: ((action: string) => void) | undefined;
  static result = { text: 'Synthetic text', confidence: 94 };
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  packets: { action: string; jobId: string }[] = [];
  terminated = false;
  hold = false;
  constructor() { FakeWorker.instances.push(this); }
  postMessage(packet: { action: string; jobId: string }) {
    this.packets.push(packet);
    if (this.hold) return;
    queueMicrotask(() => {
      this.onmessage?.({ data: { ...packet, status: 'resolve', data: packet.action === 'recognize' ? FakeWorker.result : {} } } as MessageEvent);
      FakeWorker.afterResponse?.(packet.action);
    });
  }
  terminate() { this.terminated = true; }
}

function canvas(width = 800, height = 600): HTMLCanvasElement {
  return { width, height, toBlob(callback: BlobCallback) { callback(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })); } } as HTMLCanvasElement;
}

test('offline OCR bounds dimensions before allocating a worker', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    FakeWorker.instances = [];
    const reader = createOfflineOcr('synthetic worker');
    await assert.rejects(reader.recognize(canvas(4001, 1000)), /4 million pixels/);
    await assert.rejects(reader.recognize(canvas(0, 100)), /dimensions/);
    assert.equal(FakeWorker.instances.length, 0);
    reader.dispose();
  } finally { globalThis.Worker = original; }
});

test('offline OCR reuses one initialized worker and never passes image URLs', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    FakeWorker.instances = [];
    const reader = createOfflineOcr('synthetic worker');
    assert.deepEqual(await reader.recognize(canvas()), { text: 'Synthetic text', confidence: 94 });
    await reader.recognize(canvas());
    assert.equal(FakeWorker.instances.length, 1);
    assert.deepEqual(FakeWorker.instances[0].packets.map(p => p.action), ['load', 'loadLanguage', 'initialize', 'recognize', 'recognize']);
    reader.dispose();
    assert.equal(FakeWorker.instances[0].terminated, true);
  } finally { globalThis.Worker = original; }
});

test('cancel during canvas encoding rejects immediately and fences the late callback', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    FakeWorker.instances = [];
    let complete!: BlobCallback;
    const slow = { width: 800, height: 600, toBlob(callback: BlobCallback) { complete = callback; } } as HTMLCanvasElement;
    const reader = createOfflineOcr('synthetic worker');
    const pending = reader.recognize(slow);
    reader.cancel();
    await assert.rejects(pending, /cancelled/);
    complete(new Blob([new Uint8Array([1])]));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(FakeWorker.instances.length, 0);
    assert.deepEqual(await reader.recognize(canvas()), { text: 'Synthetic text', confidence: 94 });
    reader.dispose();
  } finally { globalThis.Worker = original; }
});

test('one active OCR job, cancellation and disposal reject pending work', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    FakeWorker.instances = [];
    const reader = createOfflineOcr('synthetic worker');
    await reader.recognize(canvas());
    FakeWorker.instances[0].hold = true;
    const pending = reader.recognize(canvas());
    await assert.rejects(reader.recognize(canvas()), /already running/);
    reader.cancel();
    await assert.rejects(pending, /cancelled/);
    assert.equal(FakeWorker.instances[0].terminated, true);
    await reader.recognize(canvas());
    reader.dispose();
    await assert.rejects(reader.recognize(canvas()), /disposed/);
    assert.equal(FakeWorker.instances[1].terminated, true);
  } finally { globalThis.Worker = original; }
});

test('cancel between worker initialization stages cannot recreate a stale worker', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const reader = createOfflineOcr('synthetic worker');
  try {
    FakeWorker.instances = [];
    FakeWorker.afterResponse = action => { if (action === 'load') { FakeWorker.afterResponse = undefined; reader.cancel(); } };
    await assert.rejects(reader.recognize(canvas()), /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(FakeWorker.instances.length, 1);
    assert.equal(FakeWorker.instances[0].terminated, true);
    assert.deepEqual(FakeWorker.instances[0].packets.map(p => p.action), ['load']);
    await reader.recognize(canvas());
    assert.equal(FakeWorker.instances.length, 2);
  } finally { reader.dispose(); FakeWorker.afterResponse = undefined; globalThis.Worker = original; }
});

test('worker failure rejects the active job and a later attempt starts cleanly', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const reader = createOfflineOcr('synthetic worker');
  try {
    FakeWorker.instances = [];
    await reader.recognize(canvas());
    const failed = FakeWorker.instances[0];
    failed.hold = true;
    const pending = reader.recognize(canvas());
    await new Promise(resolve => setTimeout(resolve, 0));
    failed.onerror?.({} as Event);
    await assert.rejects(pending, /stopped/);
    assert.equal(failed.terminated, true);
    await reader.recognize(canvas());
    assert.equal(FakeWorker.instances.length, 2);
  } finally { reader.dispose(); globalThis.Worker = original; }
});

test('oversized encoded pages and invalid worker results fail closed', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const reader = createOfflineOcr('synthetic worker');
  try {
    FakeWorker.instances = [];
    const oversized = { width: 800, height: 600, toBlob(callback: BlobCallback) { callback(new Blob([new Uint8Array(16 * 1024 * 1024 + 1)])); } } as HTMLCanvasElement;
    await assert.rejects(reader.recognize(oversized), /size limit/);
    assert.equal(FakeWorker.instances.length, 0);
    FakeWorker.result = { text: 'Invalid result', confidence: Number.NaN };
    await assert.rejects(reader.recognize(canvas()), /invalid text/);
    assert.equal(FakeWorker.instances[0].terminated, true);
  } finally { reader.dispose(); FakeWorker.result = { text: 'Synthetic text', confidence: 94 }; globalThis.Worker = original; }
});
