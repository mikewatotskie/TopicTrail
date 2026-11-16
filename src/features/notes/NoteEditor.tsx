import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { TTButton, TTNoticeCard } from '../../components';
import { useTheme } from '../../core/theme/ThemeContext';
import type { AnnotationColor, AnnotationListItem, AnnotationPayload } from '../../core/services/annotations/types';
import { useNotes } from './NotesProvider';
import { ocrPlacementCopy, type OcrRenderPlacements } from './ocrPlacement';
import { useOcrNotePlacements } from './ocrPlacementHooks';
export const noteColors:Record<AnnotationColor,string>={yellow:'#F8D45A',green:'#85D4A1',blue:'#89BAF5',purple:'#CAB0ED'};
export function NoteEditor({initial,item,onClose,onReveal,onRedraw,startEditing,ocrPlacements}:{initial:AnnotationPayload;item?:AnnotationListItem;onClose():void;onReveal?():void;onRedraw?():void;startEditing?:boolean;ocrPlacements?:OcrRenderPlacements}){
  const {controller,state}=useNotes(),{colors}=useTheme();
  const draft=state.drafts.find(d=>d.id===initial.id);
  const [baseRevision]=useState(draft?.baseRevision??item?.revision??0);
  const [editing,setEditing]=useState(startEditing??(!item||!item.payload.body.trim()||!!draft));
  const [payload,setPayload]=useState(draft?.payload??initial),[busy,setBusy]=useState(false),[error,setError]=useState(''),[draftStatus,setDraftStatus]=useState(draft?'Draft recovered from this device.':''),[confirm,setConfirm]=useState<'delete'|'remove'|null>(null);
  const ocr=useOcrNotePlacements([payload],controller?.context,ocrPlacements),placement=ocr.placement(payload);
  const field=useRef<React.ComponentRef<typeof TextInput>>(null);
  const latest=state.items.find(r=>r.id===initial.id)??state.trash.find(r=>r.id===initial.id)??item;
  const locked=!!latest?.parentDeleted||!!latest?.conflict||!!latest?.deleted;
  const dirty=JSON.stringify(payload)!==JSON.stringify(initial);
  useEffect(()=>{
    if(!dirty||!controller)return;
    let current=true;
    // Start durable local persistence on every edit, including when a remote
    // Trash/conflict locks the saved item. Drafts never enter the cloud outbox.
    void controller.store.saveDraft({id:payload.id,payload,updatedAt:payload.updatedAt,baseRevision}).then(()=>{if(current)setDraftStatus(controller.context.account?'Draft saved on this device. Save to synchronize.':'Draft saved on this device. Save to finish this note.');}).catch(()=>{if(current)setDraftStatus('Draft could not be saved. Keep this editor open and retry.');});
    return()=>{current=false;};
  },[payload,dirty,controller,baseRevision]);
  const patch=(value:Partial<AnnotationPayload>)=>{setDraftStatus('Saving draft on this device…');setPayload(p=>({...p,...value,updatedAt:new Date().toISOString()}));};
  async function act(operation:()=>Promise<unknown>,close=true){if(!controller||busy)return;setBusy(true);setError('');try{await operation();if(close)onClose();}catch(reason){setError(reason instanceof Error?reason.message:'The note could not be saved. Retry.');}finally{setBusy(false);}}
  function close(){void act(async()=>{if(dirty)await controller!.store.saveDraft({id:payload.id,payload,updatedAt:payload.updatedAt,baseRevision});});}
  function save(highlightOnly=false){void act(()=>controller!.run(store=>store.save(payload,{highlightOnly,draftId:payload.id,baseRevision})));}
  const label=payload.anchor?.kind==='region'?'Area note':payload.anchor?'Passage note':payload.documentId?'Document note':'Notebook note';
  return <Modal visible transparent animationType="fade" onRequestClose={close} onShow={()=>{if(!editing)return;field.current?.focus();if(Platform.OS!=='web'){const handle=findNodeHandle(field.current);if(handle)AccessibilityInfo.setAccessibilityFocus(handle);}}}>
    <View style={{flex:1,backgroundColor:'#0008',justifyContent:'center',padding:16}} accessibilityViewIsModal>
      <KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':undefined} style={{maxHeight:'95%',width:'100%',maxWidth:680,alignSelf:'center',backgroundColor:colors.surface,borderRadius:20}}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:20,gap:16}}>
          <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8}}><Text accessibilityRole="header" style={{fontFamily:'InterSemiBold',fontSize:22,color:colors.ink,flex:1}}>{label}</Text><TTButton label="Close" variant="ghost" onPress={close} disabled={busy}/></View>
          {!!payload.location&&<Text style={{color:colors.muted}}>{payload.location.unit} {payload.location.index}</Text>}
          {payload.anchor?.kind==='text'&&<View style={{padding:12,borderLeftWidth:4,borderLeftColor:noteColors[payload.color],backgroundColor:colors.soft}}><Text selectable style={{color:colors.ink}}>{payload.anchor.quote}</Text></View>}
          {payload.anchor?.kind==='region'&&<Text style={{color:colors.muted}}>Selected area on the original PDF page. Add a note or save the area highlight.</Text>}
          {!!placement&&<TTNoticeCard title={ocrPlacementCopy[placement].label} message={ocrPlacementCopy[placement].message}/>}
          {!!ocr.warning&&<TTNoticeCard title="OCR placement unavailable" message={ocr.warning}/>}
          {locked&&<TTNoticeCard title={latest?.parentDeleted?'Document unavailable or in Trash':latest?.deleted?'Note in Trash':'Two versions need review'} message={latest?.parentDeleted?'Restore the original document before editing. This note remains saved.':latest?.deleted?'Restore this note from Saved before editing.':'Compare the cloud and device versions in Saved before editing.'}/>}
          {editing?<><TextInput ref={field} accessibilityLabel="Note title" placeholder="Title (optional)" placeholderTextColor={colors.muted} value={payload.title} onChangeText={title=>patch({title})} editable={!busy&&!locked} maxLength={512} style={{minHeight:48,borderWidth:1,borderColor:colors.border,borderRadius:10,padding:12,color:colors.ink}}/>
          <TextInput accessibilityLabel="Note text" placeholder="Write your note…" placeholderTextColor={colors.muted} value={payload.body} onChangeText={body=>patch({body})} editable={!busy&&!locked} multiline maxLength={16000} textAlignVertical="top" style={{minHeight:160,borderWidth:1,borderColor:colors.border,borderRadius:10,padding:12,color:colors.ink,fontSize:16}}/>
          <Text style={{color:colors.muted}}>{payload.body.length}/16,000 characters · plain text</Text>
          <Text style={{fontFamily:'InterSemiBold',color:colors.ink}}>Highlight color</Text>
          <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{(Object.keys(noteColors) as AnnotationColor[]).map(color=><TTButton key={color} label={(payload.color===color?'✓ ':'')+color[0].toUpperCase()+color.slice(1)} semanticLabel={color+' highlight'} accessibilityState={{selected:payload.color===color}} variant="secondary" disabled={busy||locked} onPress={()=>patch({color})} style={{borderColor:noteColors[color],borderWidth:payload.color===color?3:1}}/>)}</View>
          </>:<View style={{gap:12}}>{!!payload.title&&<Text selectable style={{fontSize:20,fontFamily:'InterSemiBold',color:colors.ink}}>{payload.title}</Text>}<Text selectable style={{fontSize:16,lineHeight:24,color:colors.ink}}>{payload.body}</Text><Text style={{color:colors.muted}}>{payload.color[0].toUpperCase()+payload.color.slice(1)} highlight · {latest?.syncStatus==='synced'?'Synced':latest?.syncStatus==='pending'?'Waiting to sync':'Saved on this device'}</Text><TTButton label="Edit note or color" variant="secondary" disabled={locked} onPress={()=>setEditing(true)}/></View>}
          {!!draftStatus&&<Text accessibilityLiveRegion="polite" style={{color:colors.muted}}>{draftStatus}</Text>}
          <Text style={{color:colors.muted}}>{controller?.context.account?'Saved notes and quoted passages synchronize privately with this account. Drafts stay on this device.':'Guest notes stay on this device until you choose to copy them to an account.'}</Text>
          {!!error&&<TTNoticeCard type="error" title="Note not saved" message={error}/>}
          <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
            {editing&&<TTButton label="Save note" isLoading={busy} disabled={locked||!payload.body.trim()||!controller} onPress={()=>save()}/>}
            {!!payload.anchor&&!payload.body.trim()&&<TTButton label="Save highlight only" variant="secondary" disabled={busy||locked} onPress={()=>save(true)}/>}
            {onReveal&&<TTButton label="Go to passage" variant="secondary" disabled={busy} onPress={onReveal}/>}
            {onRedraw&&<TTButton label="Redraw area" variant="secondary" disabled={busy} onPress={()=>{onClose();onRedraw();}}/>}
          </View>
          {latest&&!locked&&<View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
            {!!latest.payload.anchor&&!!latest.payload.body&&<TTButton label="Remove note, keep highlight" variant="ghost" disabled={busy} onPress={()=>setConfirm('remove')}/>}
            <TTButton label={latest.payload.anchor?'Delete highlight and note':'Move note to Trash'} variant="ghost" disabled={busy} onPress={()=>setConfirm('delete')}/>
          </View>}
          {(dirty||draft)&&<TTButton label="Discard draft" variant="ghost" disabled={busy} onPress={()=>void act(()=>controller!.store.discardDraft(payload.id))}/>}
          {confirm&&<View style={{padding:12,gap:8,borderWidth:1,borderColor:colors.border,borderRadius:12}}><Text style={{color:colors.ink}}>{confirm==='remove'?'Remove the note text and keep its colored highlight?':'Move this item to Trash? You can restore it from Saved.'}</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}><TTButton label="Confirm" variant="danger" disabled={busy} onPress={()=>void act(async()=>{await controller!.run(store=>confirm==='remove'?store.removeNote(payload.id,{baseRevision}):store.remove(payload.id,{baseRevision}));await controller!.store.discardDraft(payload.id);})}/><TTButton label="Cancel" variant="ghost" disabled={busy} onPress={()=>setConfirm(null)}/></View></View>}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  </Modal>;
}
