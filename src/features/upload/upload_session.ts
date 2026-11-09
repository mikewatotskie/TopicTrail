import type { DocumentPickerAsset } from 'expo-document-picker';
import type { GuestUploadPolicy } from '../../core/config/guest_upload_policy';
import { createImportAttempt, ImportResult, importFailure, type GuestAllowance, type GuestImportOutcome, type ImportActor, type ImportAttempt } from '../../core/services/document_import_contract';
export type UploadPrompt = 'limit' | 'unavailable' | null;
export function uploadAction(result?: ImportResult) {
  if (!result) return 'submit';
  if (result.success && result.document) return 'open';
  switch (result.code) {
    case 'already_deleted': return 'library';
    case 'reselect': return 'reselect';
    case 'storage_conflict': return 'conflict';
    case 'guest_limit': return 'limit';
    case 'guest_usage_recovery': return 'unavailable';
    default: return 'retry';
  }
}
export interface UploadDependencies {
  policy: GuestUploadPolicy;
  pick(): Promise<DocumentPickerAsset | null>;
  discard(uri: string): void;
  importFile(uri: string, name: string, attempt: ImportAttempt): Promise<ImportResult>;
  allowance(): Promise<GuestAllowance>;
  lookup(attemptId: string): Promise<GuestImportOutcome>;
}
export interface UploadSnapshot {
  sessionId: string | null; attemptId: string | null; asset: DocumentPickerAsset | null;
  picking: boolean; processing: boolean; allowance: GuestAllowance | null;
  result?: ImportResult; prompt: UploadPrompt;
}
/** Route-independent memory owner. No IO on construction, ensure, auth return or subscription. */
export class UploadSession {
  private state: UploadSnapshot;
  private listeners = new Set<() => void>();
  private pickPromise?: Promise<void>;
  private submitPromise?: Promise<ImportResult | undefined>;
  private refreshPromise?: Promise<void>;
  private disposed = false;
  constructor(private readonly io: UploadDependencies) {
    this.state = { sessionId:null, attemptId:null, asset:null, picking:false, processing:false,
      allowance:io.policy === 'disabled' ? {kind:'disabled'} : null, prompt:null };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<UploadSnapshot>) { if (this.disposed) return; this.state = {...this.state,...patch}; this.listeners.forEach(listener=>listener()); }
  ensure() { if (!this.state.sessionId) this.update({sessionId:createImportAttempt().attemptId,picking:!!this.pickPromise,processing:!!this.submitPromise}); return this.state.sessionId!; }
  matches(id?: string) { return !!id && id === this.state.sessionId; }
  dismissPrompt() { this.update({prompt:null}); }
  refresh(): Promise<void> {
    if (this.io.policy === 'disabled') return Promise.resolve();
    if (this.refreshPromise) return this.refreshPromise;
    const received=(allowance:GuestAllowance)=>{
      const prompt=this.state.prompt ? (allowance.kind==='ready' && allowance.remaining>0 ? null
        : allowance.kind==='ready' && allowance.used===2 && allowance.remaining===0 ? 'limit' : 'unavailable') : null;
      this.update({allowance,prompt});
    };
    this.refreshPromise = this.io.allowance().then(received,()=>received({kind:'recovery_required'})).finally(()=>{this.refreshPromise=undefined});
    return this.refreshPromise;
  }
  private gate(actor: ImportActor) {
    if (this.io.policy === 'disabled' || actor.kind === 'account') return true;
    const allowance=this.state.allowance;
    if (allowance?.kind === 'ready' && allowance.remaining > 0) return true;
    this.update({prompt:allowance?.kind === 'ready' && allowance.used === 2 && allowance.remaining === 0 ? 'limit' : 'unavailable'});return false;
  }
  check(actor: ImportActor) { this.dismissPrompt();return this.gate(actor); }
  pick(actor: ImportActor): Promise<void> {
    if (this.pickPromise) return this.pickPromise;
    if (this.submitPromise || this.state.processing || !this.gate(actor) || this.disposed) return Promise.resolve();
    const sessionId=this.ensure();
    this.update({picking:true});
    // Invoke before any await; web pickers require the original button gesture.
    let picked: Promise<DocumentPickerAsset|null>;
    try { picked=this.io.pick(); } catch(error) { picked=Promise.reject(error); }
    this.pickPromise=picked.then(asset=>{
      if (this.disposed || !this.matches(sessionId)) { if(asset)this.io.discard(asset.uri);return; }
      if(asset) { if(this.state.asset && this.state.asset.uri!==asset.uri)this.io.discard(this.state.asset.uri);
        this.update({asset,attemptId:createImportAttempt().attemptId,result:undefined,prompt:null}); }
    },error=>{if(this.matches(sessionId))this.update({result:new ImportResult(false,undefined,error instanceof Error?error.message:'Unable to choose file',false,'reselect')});})
      .finally(()=>{this.pickPromise=undefined;this.update({picking:false});});
    return this.pickPromise;
  }
  submit(actor: ImportActor): Promise<ImportResult | undefined> {
    if(this.submitPromise)return this.submitPromise;
    if(this.disposed || !this.state.asset || this.state.picking)return Promise.resolve(undefined);
    const {asset,attemptId,sessionId}=this.state;
    const attempt:ImportAttempt={attemptId:attemptId!,actor:{...actor}};
    const current=()=>!this.disposed && this.matches(sessionId ?? undefined);
    let released=false;
    const releaseSelection=()=>{if(!released){released=true;this.io.discard(asset.uri);}};
    this.update({processing:true,prompt:null});
    this.submitPromise=(async()=>{
      let result:ImportResult;
      try {
        // Verify uncertain prior commits before a retry can touch staging or save again.
        let prior:GuestImportOutcome;
        try { prior=await this.io.lookup(attempt.attemptId); }
        catch(error) {
          if(this.io.policy!=='disabled' && attempt.actor.kind==='guest') {
            result=new ImportResult(false,undefined,'Guest upload allowance could not be verified.',false,'guest_usage_recovery');
            if(current()) {
              // A failed receipt read invalidates any previously hydrated guest allowance.
              this.update({allowance:{kind:'recovery_required'},prompt:'unavailable',result});
              await this.refresh();
              if(!current())return result;
              // Even a healthy allowance read cannot confirm this attempt's receipt.
              this.update({prompt:'unavailable'});
            }
            return result;
          }
          throw error;
        }
        if(!current())return undefined;
        if(prior.kind==='committed')result=new ImportResult(true,prior.document,undefined,false,'committed');
        else if(prior.kind==='deleted')result=new ImportResult(false,undefined,'This document was deleted.',false,'already_deleted');
        else if(!this.gate(attempt.actor))return undefined;
        else result=await this.io.importFile(asset.uri,asset.name,attempt);
      } catch(error) { result=importFailure(error,'Unable to import document'); }
      if(current()) {
        const completed=(result.success && !!result.document)||result.code==='already_deleted';
        if(completed)releaseSelection();
        this.update({result,...(completed?{asset:null}:{})});
        if(result.code==='storage_conflict'||result.code==='guest_limit'||result.code==='guest_usage_recovery')await this.refresh();
        if(!current())return result;
        if(result.code==='guest_limit'||result.code==='guest_usage_recovery'||result.code==='storage_conflict')this.gate(attempt.actor);
      }
      return result;
    })().finally(()=>{if(!current())releaseSelection();this.submitPromise=undefined;this.update({processing:false});});
    return this.submitPromise;
  }
  cancel() { const asset=this.state.asset;if(asset && !this.state.processing)this.io.discard(asset.uri);
    this.update({sessionId:null,attemptId:null,asset:null,picking:false,processing:false,result:undefined,prompt:null}); }
  dispose() { this.cancel();this.disposed=true;this.listeners.clear(); }
}
