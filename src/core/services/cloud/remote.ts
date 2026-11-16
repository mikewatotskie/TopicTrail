import { validateSupabaseConfiguration, type SupabaseConfiguration } from '../../auth/supabase_config';
import { strFromU8 } from 'fflate';
import type { Document } from '../../models/document';
import { MAX_FILE_SIZE_BYTES, validateDocument } from '../document_validation';
import { sha256 } from './sha256';
import { SyncRateLimit } from './sync_retry';
import { LibraryPull } from './paged_pull';
import { cloudIdentityKey, type CloudDocumentRow, type CloudRemote, type CloudSession } from './types';
import { validateStudyRecord, type StudyReply } from './study_state';
import { usesStagingQuotas } from './quota_routes';

const BUCKET = 'topictrail-documents';
const TABLE = 'topictrail_cloud_documents';
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const COLUMNS = 'user_id,id,title,format,byte_size,sha256,imported_at,object_path,created_at';
const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
class RequestFailure extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const invalid = () => new Error('The cloud document is invalid or belongs to another account.');

async function boundedBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw invalid();
  // Browsers stream and stop immediately at the bound; React Native may expose only arrayBuffer.
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw invalid();
    return bytes;
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > limit) { void reader.cancel().catch(() => undefined); throw invalid(); }
      chunks.push(result.value);
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function createCloudRemote(config: SupabaseConfiguration, session: CloudSession,
  signal?: AbortSignal, fetcher: typeof fetch = globalThis.fetch, pull = new LibraryPull()): CloudRemote {
  const scope=cloudIdentityKey(session);
  const validated = validateSupabaseConfiguration(config.url, config.publishableKey);
  if (validated.namespace !== session.project || config.namespace !== session.project ||
      typeof session.accessToken !== 'string' || !session.accessToken.trim() || /[\r\n]/.test(session.accessToken)) throw invalid();
  // Copy the capability: callers cannot retarget an in-flight remote by mutating its session object.
  const uid = session.uid, token = session.accessToken, base = validated.url, key = validated.publishableKey;
  const quotaRoutes = usesStagingQuotas(validated.namespace);
  const checkActive = () => { if (signal?.aborted) throw new RequestFailure(0, 'Cloud synchronization was cancelled.'); };
  const validateRow = (value: unknown): CloudDocumentRow => {
    if (!value || typeof value !== 'object') throw invalid();
    const row = value as CloudDocumentRow;
    if (row.user_id !== uid || typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(row.id) ||
        typeof row.title !== 'string' || !row.title.trim() || Array.from(row.title).length > 512 ||
        (row.format !== 'pdf' && row.format !== 'docx' && row.format !== 'pptx') || !Number.isInteger(row.byte_size) ||
        row.byte_size < 1 || row.byte_size > MAX_FILE_SIZE_BYTES || typeof row.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row.sha256) || typeof row.imported_at !== 'string' || !Number.isFinite(Date.parse(row.imported_at)) ||
        row.object_path !== `${uid}/${row.id}.${row.format}` ||
        (row.created_at !== undefined && (typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))))) throw invalid();
    return { user_id: uid, id: row.id, title: row.title, format: row.format, byte_size: row.byte_size,
      sha256: row.sha256, imported_at: row.imported_at, object_path: row.object_path,
      ...(row.created_at === undefined ? {} : { created_at: row.created_at }) };
  };
  const request = async <T>(path: string, init: RequestInit, read: (response: Response, requestSignal: AbortSignal) => Promise<T>): Promise<T> => {
    checkActive();
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let stop!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      stop = () => { controller.abort(); reject(new RequestFailure(0, 'Cloud synchronization was cancelled.')); };
      signal?.addEventListener('abort', stop, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new RequestFailure(0, 'Cloud synchronization timed out. Please retry.')); }, REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([cancelled, (async () => {
        const response = await fetcher(`${base}${path}`, { ...init, redirect: 'error', signal: controller.signal,
          headers: { apikey: key, Authorization: `Bearer ${token}`, ...init.headers } });
        if (response.status === 429) throw SyncRateLimit.fromResponse(response);
        if (!response.ok) throw new RequestFailure(response.status, response.status === 401 || response.status === 403
          ? 'Your cloud session is unavailable. Sign in again to synchronize.'
          : response.status === 413 ? 'This file exceeds the cloud upload limit.' : 'Cloud synchronization could not finish. Please retry.');
        const value = await read(response, controller.signal); checkActive(); return value;
      })()]);
    } catch (error) {
      if (error instanceof RequestFailure || error instanceof SyncRateLimit) throw error;
      throw new RequestFailure(0, 'Cloud synchronization could not finish. Check your connection and retry.');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  };
  const postJson = (value: unknown): RequestInit => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  const rows = (after: string, exact?: string) => {
    const query = exact ? `id=eq.${exact}&limit=1` : `order=id.asc&limit=${PAGE_SIZE}${after ? `&id=gt.${after}` : ''}`;
    const path = quotaRoutes ? '/rest/v1/rpc/topictrail_v2_documents_list' : `/rest/v1/${TABLE}?select=${COLUMNS}&user_id=eq.${uid}&${query}`;
    const init = quotaRoutes ? postJson({ p_after_id: after, p_exact_id: exact ?? null }) : { method: 'GET', headers: { Accept: 'application/json' } };
    return request(path, init, async (response, requestSignal) => {
      const bytes = await boundedBytes(response, 2 * 1024 * 1024, requestSignal);
      const value: unknown = JSON.parse(strFromU8(bytes));
      if (!Array.isArray(value) || value.length > PAGE_SIZE) throw invalid();
      return value.map(validateRow);
    });
  };
  const verifyBytes = (row: CloudDocumentRow, bytes: Uint8Array) => {
    if (bytes.length !== row.byte_size || sha256(bytes) !== row.sha256) throw new Error('The cloud copy did not pass its integrity check. Please retry.');
    try { if (validateDocument(`${row.id}.${row.format}`, bytes) !== row.format) throw invalid(); }
    catch { throw new Error('The cloud copy has an invalid document format.'); }
  };
  const download = async (value: CloudDocumentRow) => {
    checkActive(); const row = validateRow(value);
    const bytes = await request(`/storage/v1/object/authenticated/${BUCKET}/${row.object_path}`, { method: 'GET' },
      (response, requestSignal) => boundedBytes(response, row.byte_size, requestSignal));
    verifyBytes(row, bytes); checkActive(); return bytes;
  };
  const canReconcile = (error: unknown) => error instanceof RequestFailure && [0, 400, 409, 500, 502, 503, 504].includes(error.status);
  return {
    async listStudy(){
      return pull.study.collect(scope,
        previous=>request(quotaRoutes ? '/rest/v1/rpc/topictrail_v2_study_list' : '/rest/v1/rpc/topictrail_sync_list',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_after_kind:previous?.kind??'',p_after_id:previous?.id??'',p_limit:100})},async(response,requestSignal)=>{
          const raw:unknown=JSON.parse(strFromU8(await boundedBytes(response,4*1024*1024,requestSignal)));
          if(!Array.isArray(raw)||raw.length>100)throw invalid();return raw.map(validateStudyRecord);
        }), (row,previous)=>row.kind>previous.kind||(row.kind===previous.kind&&row.id>previous.id), invalid, 20000);
    },
    async applyStudy(mutation){
      return request(quotaRoutes ? '/rest/v1/rpc/topictrail_v2_study_apply' : '/rest/v1/rpc/topictrail_sync_apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_mutation:mutation})},async(response,requestSignal)=>{
        const raw=JSON.parse(strFromU8(await boundedBytes(response,65536,requestSignal))) as StudyReply;
        if(!raw||!['applied','conflict'].includes(raw.status))throw invalid();
        const record=validateStudyRecord(raw.record);if(record.kind!==mutation.kind||record.id!==mutation.id)throw invalid();
        return {status:raw.status,record,...(raw.duplicate===true?{duplicate:true}:{})};
      });
    },
    async list() {
      return pull.documents.collect(scope, previous=>rows(previous?.id??''), (row,previous)=>row.id>previous.id, invalid);
    },
    download,
    async upload(document: Document, bytes: Uint8Array) {
      checkActive();
      if (!(document.importedAt instanceof Date) || !Number.isFinite(document.importedAt.getTime())) throw invalid();
      const row = validateRow({ user_id: uid, id: document.id, title: document.title, format: document.format,
        byte_size: bytes.length, sha256: sha256(bytes), imported_at: document.importedAt.toISOString(),
        object_path: `${uid}/${document.id}.${document.format}` });
      verifyBytes(row, bytes);
      const alreadyUploaded = quotaRoutes && await request('/rest/v1/rpc/topictrail_v2_reserve_upload',
        postJson({ p_id: row.id, p_format: row.format, p_size: row.byte_size }), async (response, requestSignal) => {
          const lease = JSON.parse(strFromU8(await boundedBytes(response, 1024, requestSignal)));
          if (lease?.already_uploaded === true) return true;
          if (typeof lease?.expires_at !== 'string' || !Number.isFinite(Date.parse(lease.expires_at))) throw invalid();
          return false;
        });
      if (alreadyUploaded) {
        await download(row);
      } else {
        try {
          await request(`/storage/v1/object/${BUCKET}/${row.object_path}`, { method: 'POST',
            headers: { 'Content-Type': MIME[row.format], 'x-upsert': 'false', 'Cache-Control': 'max-age=0' },
            body: bytes as unknown as BodyInit }, async () => undefined);
        } catch (error) {
          checkActive(); if (!canReconcile(error)) throw error;
          // A lost reply can mean the original upload succeeded. Accept only identical owned bytes.
          await download(row);
        }
      }
      const insert = { user_id: row.user_id, id: row.id, title: row.title, format: row.format,
        byte_size: row.byte_size, sha256: row.sha256, imported_at: row.imported_at };
      try {
        if (quotaRoutes) {
          await request('/rest/v1/rpc/topictrail_v2_documents_insert', postJson({ p_document: insert }), async () => undefined);
        } else {
          await request(`/rest/v1/${TABLE}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify(insert) }, async () => undefined);
        }
        return row;
      } catch (error) {
        checkActive(); if (!canReconcile(error)) throw error;
        const found = await rows('', row.id);
        const existing = found[0];
        // Titles can be renamed locally, and deterministic sample IDs may be imported at
        // different times on different devices. Reconcile content/identity and return the
        // original cloud metadata without replacing either device's local metadata.
        if (found.length !== 1 || existing.id !== row.id || existing.format !== row.format ||
            existing.byte_size !== row.byte_size || existing.sha256 !== row.sha256 ||
            existing.object_path !== row.object_path) {
          throw new Error('A different cloud document already uses this identity. Your device copy has been preserved.');
        }
        return existing;
      }
    },
  };
}
