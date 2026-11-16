import { strFromU8 } from 'fflate';
import { validateSupabaseConfiguration, type SupabaseConfiguration } from '../../auth/supabase_config';
import { cloudIdentityKey, type CloudSession } from '../cloud/types';
import { usesStagingQuotas } from '../cloud/quota_routes';
import { SyncRateLimit } from '../cloud/sync_retry';
import { PagedPull } from '../cloud/paged_pull';
import type { AnnotationRecord, AnnotationRemote } from './types';
import { annotationError, annotationObject, validateAnnotationMutation, validateAnnotationRecord, validateAnnotationReply } from './validation';

class AnnotationRequestError extends Error {}
const cancelled = () => new AnnotationRequestError('Notes synchronization was cancelled.');

async function boundedJson(response:Response,limit:number,signal:AbortSignal):Promise<unknown> {
  const length=response.headers.get('content-length');
  if(length!==null && (!/^\d+$/.test(length) || Number(length)>limit))throw annotationError();
  if(!response.body?.getReader) {
    const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>limit)throw annotationError();return JSON.parse(strFromU8(bytes));
  }
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  const stop=()=>{void reader.cancel().catch(()=>undefined);};signal.addEventListener('abort',stop,{once:true});
  if(signal.aborted)stop();
  try {
    while(true) {
      const part=await reader.read();if(part.done)break;size+=part.value.length;
      if(size>limit){void reader.cancel().catch(()=>undefined);throw annotationError();}chunks.push(part.value);
    }
  } finally {signal.removeEventListener('abort',stop);reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(strFromU8(bytes));
}

/** Reuses the existing account's short-lived session capability. No auth client,
 * token persistence, manual refresh, new endpoint, or automatic external upload. */
export function createAnnotationRemote(configuration:SupabaseConfiguration,session:CloudSession,signal?:AbortSignal,fetcher:typeof fetch=globalThis.fetch,pull=new PagedPull<AnnotationRecord>()):AnnotationRemote {
  const scope=cloudIdentityKey(session);
  const config=validateSupabaseConfiguration(configuration.url,configuration.publishableKey);
  if(config.namespace!==session.project || configuration.namespace!==session.project || typeof session.accessToken!=='string' ||
      !session.accessToken.trim() || /[\r\n]/.test(session.accessToken))throw annotationError();
  const uid=session.uid,token=session.accessToken;
  const route = usesStagingQuotas(config.namespace) ? 'topictrail_v2_annotations' : 'topictrail_annotations_v1';
  const check=()=>{if(signal?.aborted)throw cancelled();};
  async function request(name:'list'|'apply',body:unknown):Promise<unknown> {
    check();const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let stop!:()=>void;
    const cancellation=new Promise<never>((_,reject)=>{
      stop=()=>{controller.abort();reject(cancelled());};signal?.addEventListener('abort',stop,{once:true});
      timer=setTimeout(()=>{controller.abort();reject(new AnnotationRequestError('Notes synchronization timed out. Your notes remain saved on this device. Retry when ready.'));},30000);
    });
    try {
      return await Promise.race([cancellation,(async()=>{
        const response=await fetcher(`${config.url}/rest/v1/rpc/${route}_${name}`,{method:'POST',redirect:'error',signal:controller.signal,
          headers:{apikey:config.publishableKey,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
        if(response.status===429)throw SyncRateLimit.fromResponse(response);
        if(!response.ok)throw new AnnotationRequestError(response.status===404
          ?'Notes cloud sync is not available yet. Your notes are saved on this device.'
          :response.status===401||response.status===403?'Sign in again to synchronize notes. Your notes remain saved on this device.'
          :'Notes could not synchronize. Your notes remain saved on this device. Please retry.');
        const result=await boundedJson(response,name==='list'?4*1024*1024:128*1024,controller.signal);check();return result;
      })()]);
    } catch(error) {
      if(error instanceof SyncRateLimit || error instanceof AnnotationRequestError || (error instanceof Error && /invalid.*preserved/.test(error.message)))throw error;
      throw new AnnotationRequestError('Notes could not synchronize. Your notes remain saved on this device. Check your connection and retry.');
    } finally {if(timer!==undefined)clearTimeout(timer);signal?.removeEventListener('abort',stop);}
  }
  return {
    async list() {
      return pull.collect(scope,async previous=>{
        const raw=await request('list',{p_after_id:previous?.id??'',p_limit:100});
        if(!Array.isArray(raw) || raw.length>100)throw annotationError();
        return raw.map(value=>{
          const envelope=annotationObject(value);if(envelope.owner!==uid || Object.keys(envelope).length!==2)throw annotationError();
          return validateAnnotationRecord(envelope.record);
        });
      }, (row,previous)=>row.id>previous.id, annotationError, 20000);
    },
    async apply(value) {
      const mutation=validateAnnotationMutation(value);const raw=annotationObject(await request('apply',{p_mutation:mutation}));
      if(raw.owner!==uid)throw annotationError();const {owner:_owner,...reply}=raw;
      const result=validateAnnotationReply(reply);if(result.record.id!==mutation.id)throw annotationError();return result;
    },
  };
}
