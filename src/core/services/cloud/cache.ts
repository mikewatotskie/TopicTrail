import { Directory, File, Paths } from 'expo-file-system';
import { strToU8 } from 'fflate';
import { MAX_FILE_SIZE_BYTES } from '../document_validation';
import { isOwnedDocumentUri } from '../file_ownership';
import { createAccountCache, type CachePort, type CacheSnapshot, type CacheWrite } from './cache_store';
import { sha256 } from './sha256';
import { cloudIdentityKey, type CloudCache, type CloudIdentity } from './types';
import { productionMetadata } from '../study_metadata';
import { studyTransferNative } from '../study_transfer_native';
import { packAccountEnvelope, unpackAccountEnvelope } from './cache_envelope';

const caches = new Map<string, CloudCache>();
const corruptMetadata = () => new Error('Account library metadata could not be read. Existing data has been preserved.');

async function boundedBytes(file: File): Promise<Uint8Array> {
  if ((file.size ?? 0) > MAX_FILE_SIZE_BYTES) throw new Error('This document exceeds the 50 MiB limit.');
  return file.bytes();
}

function nativePort(directory: Directory, scope: string): CachePort {
  const metadataKey = ['account/' + scope + '/library'];
  function ownedFile(path: string) {
    if (!isOwnedDocumentUri(path, directory.uri)) throw corruptMetadata();
    return new File(path);
  }
  const slotFile = (slot: number) => new File(directory, 'library-' + slot + '.json');

  async function readSlot(slot: number): Promise<CacheSnapshot | null> {
    const file = slotFile(slot);
    if (!file.exists) return null;
    try {
      const snapshot = JSON.parse(await file.text());
      if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 ||
          snapshot.revision % 2 !== slot || typeof snapshot.json !== 'string' ||
          snapshot.checksum !== sha256(strToU8(snapshot.revision + ':' + snapshot.json))) throw corruptMetadata();
      return { revision: snapshot.revision, json: snapshot.json };
    } catch {
      throw corruptMetadata();
    }
  }

  async function readState(): Promise<CacheSnapshot> {
    const store = productionMetadata();
    if (store) return unpackAccountEnvelope((await store.read(metadataKey))[0]);
    // Only the older slot is replaced. If promotion is interrupted before
    // the move, the latest committed slot still supplies metadata and receipts.
    const [even, odd] = await Promise.all([readSlot(0), readSlot(1)]);
    if (even && odd) {
      if (Math.abs(even.revision - odd.revision) !== 1) throw corruptMetadata();
      return even.revision > odd.revision ? even : odd;
    }
    return even ?? odd ?? { revision: 0, json: null };
  }

  async function writeBytes(write: CacheWrite): Promise<void> {
    const file = ownedFile(write.path);
    if (file.exists) {
      // A prior attempt can have promoted bytes before its metadata commit.
      // Reuse exactly matching bytes and never replace an existing document.
      if (file.size !== write.bytes.byteLength || await file.digest('SHA-256') !== write.hash) {
        throw new Error('Existing account document bytes conflict with this file and have been preserved.');
      }
      return;
    }
    const staging = new File(directory, 'incoming-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
    staging.create();
    try {
      await staging.write(write.bytes);
      const transfer = studyTransferNative();
      if (transfer.role === 'production') {
        await transfer.publishOriginal(staging.uri, 'topictrail-cloud-v1/' + scope + '/' + file.name, write.bytes.byteLength, write.hash, true);
      } else {
        if (staging.size !== write.bytes.byteLength || await staging.digest('SHA-256') !== write.hash) {
          throw new Error('The staged account document failed its integrity check.');
        }
        await staging.move(file, { overwrite: false });
      }
    } finally {
      // Expo move changes the File instance URI to its destination.
      if (staging.uri !== file.uri && staging.exists) staging.delete();
    }
  }

  return {
    path: (id, format) => new File(directory, id + '.' + format).uri,
    readState,
    async commit(expectedRevision, json, write) {
      const store = productionMetadata();
      if (store) {
        const previous = await store.read(metadataKey);
        if (unpackAccountEnvelope(previous[0]).revision !== expectedRevision) return false;
        directory.create({ idempotent: true, intermediates: true });
        if (write) await writeBytes(write);
        return store.compareAndSet(metadataKey, previous, [packAccountEnvelope(expectedRevision + 1, json)]);
      }
      if ((await readState()).revision !== expectedRevision) return false;
      directory.create({ idempotent: true, intermediates: true });
      if (write) await writeBytes(write);
      const revision = expectedRevision + 1;
      if (!Number.isSafeInteger(revision)) throw corruptMetadata();
      const staging = new File(directory, 'library.pending.json');
      const serialized = JSON.stringify({ revision, json, checksum: sha256(strToU8(revision + ':' + json)) });
      await staging.write(serialized);
      if (await staging.text() !== serialized) throw corruptMetadata();
      // This replaces metadata only. The latest before-image is the other slot.
      await staging.move(slotFile(revision % 2), { overwrite: true });
      return true;
    },
    async readFile(path) {
      const file = ownedFile(path);
      return file.exists ? boundedBytes(file) : null;
    },
    async fileExists(path) { return ownedFile(path).exists; },
    async readImport(path) { return boundedBytes(new File(path)); },
  };
}

export function accountFilePort(identity: CloudIdentity): CachePort {
  const key = cloudIdentityKey(identity);
  const directory = new Directory(Paths.document, 'topictrail-cloud-v1', identity.project, identity.uid);
  return nativePort(directory, key);
}
export function createCloudCache({ project, uid }: CloudIdentity): CloudCache {
  const identity = { project, uid };
  const key = cloudIdentityKey(identity);
  let cache = caches.get(key);
  if (!cache) {
    cache = createAccountCache(identity, accountFilePort(identity));
    caches.set(key, cache);
  }
  return cache;
}
