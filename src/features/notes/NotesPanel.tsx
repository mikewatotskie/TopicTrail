import React, {useMemo,useRef,useState} from 'react';
import {ActivityIndicator,Modal,Pressable,ScrollView,Text,View} from 'react-native';
import {useRouter} from 'expo-router';
import {TTButton,TTCard,TTEmptyState,TTNoticeCard,TTSearchInput,TTScreen,TTIconButton,TTFigmaIcon} from '../../components';
import {TTAppBar} from '../../navigation';
import {TTTypography} from '../../core/design/tokens';
import {useColors} from '../../core/theme/ThemeContext';
import type {AnnotationListItem,AnnotationPayload} from '../../core/services/annotations/types';
import {createAnnotationPort} from '../../core/services/annotation_port';
import {useNotes} from './NotesProvider';
import {NoteEditor,noteColors} from './NoteEditor';
import {newNotePayload} from './note_selection';
import {conflictChoices,filterNoteDrafts,filterNotes,noteContext,noteTitle,type NotesFilter} from './notesListView';
import {ocrPlacementCopy,type OcrRenderPlacements} from './ocrPlacement';
import {useOcrNotePlacements} from './ocrPlacementHooks';

const syncLabels={local:'Saved on this device',pending:'Waiting to sync',synced:'Synced',conflict:'Needs attention'};
export function NotesPanel({documentId,onReveal,view='notes',startNew=false,ocrPlacements}:{documentId?:string;onReveal?(item:AnnotationListItem):void;view?:'notes'|'highlights';startNew?:boolean;ocrPlacements?:OcrRenderPlacements}) {
  const router = useRouter();
  const {controller,state}=useNotes();const {colors}=useColors();
  const [query,setQuery]=useState(''),[context,setContext]=useState<NotesFilter['context']>('all'),[color,setColor]=useState<NotesFilter['color']>('all');
  const [showTrash,setShowTrash]=useState(false),[showUnavailable,setShowUnavailable]=useState(false),[detailsId,setDetailsId]=useState<string|null>(null);
  const [editor,setEditor]=useState<AnnotationPayload|null>(()=>startNew?newNotePayload():null);
  const [editorFallback,setEditorFallback]=useState<AnnotationListItem|undefined>();
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmTrash,setConfirmTrash]=useState(false);
  const [confirmCopy,setConfirmCopy]=useState(false),[copyResult,setCopyResult]=useState('');
  const lock=useRef(false);
  const filter:NotesFilter={view,query,context,color,showUnavailable,documentId};
  const source=showTrash?state.trash:state.items;
  const entries=filterNotes(source,filter),drafts=showTrash?[]:filterNoteDrafts(state.drafts,filter);
  const unavailable=filterNotes(source,{...filter,showUnavailable:true}).filter(item=>item.parentDeleted).length;
  const allItems=useMemo(()=>[...state.items,...state.trash],[state.items,state.trash]);
  const placementPayloads=useMemo(()=>[...allItems.flatMap(item=>[item.payload,...(item.conflict?[item.conflict.local.payload,item.conflict.cloud.payload]:[])]),...state.drafts.map(draft=>draft.payload)],[allItems,state.drafts]);
  const ocr=useOcrNotePlacements(placementPayloads,controller?.context,ocrPlacements);
  const details=allItems.find(item=>item.id===detailsId);
  const editorItem=allItems.find(item=>item.id===editor?.id)??editorFallback;
  async function act(operation:()=>Promise<unknown>,close=false) {
    if(lock.current||!controller)return;lock.current=true;setBusy(true);setError('');
    try{await operation();if(close){setDetailsId(null);setConfirmTrash(false);}}catch(reason){setError(reason instanceof Error?reason.message:'This change could not be saved. Retry.');}
    finally{lock.current=false;setBusy(false);}
  }
  async function createNote(){
    if(!controller)return;
    await act(async()=>{
      let payload=newNotePayload();
      if(documentId){const parent=await controller.context.parent(documentId);controller.context.checkActive();if(!parent||parent.deleted)throw Error('Restore or download this document before adding a note.');payload={...payload,documentId,documentHash:parent.hash,format:parent.format};}
      setEditorFallback(undefined);setEditor(payload);
    });
  }
  async function openDraft(payload:AnnotationPayload){
    if(!controller)return;
    await act(async()=>{
      let parentDeleted=false;
      if(payload.documentId){const parent=await controller.context.parent(payload.documentId);controller.context.checkActive();parentDeleted=!parent||parent.deleted||parent.hash!==payload.documentHash||parent.format!==payload.format;}
      setEditorFallback(parentDeleted?{id:payload.id,payload,revision:0,deleted:false,parentDeleted:true,syncStatus:'local'}:undefined);setEditor(payload);
    });
  }
  function reveal(item:AnnotationListItem){
    if(!item.payload.documentId||item.parentDeleted)return;
    setDetailsId(null);setEditor(null);
    if(onReveal)onReveal(item);else router.push({pathname:'/reader/[documentId]',params:{documentId:item.payload.documentId,annotationId:item.id}});
  }
  const toggle=(label:string,selected:boolean,onPress:()=>void)=><Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{selected}} aria-selected={selected} onPress={onPress}
    style={({pressed})=>({minHeight:48,paddingHorizontal:16,paddingVertical:12,borderRadius:12,borderWidth:1,borderColor:selected?colors.link:colors.border,backgroundColor:selected?colors.soft:colors.surface,justifyContent:'center',opacity:pressed?0.75:1})}>
    <Text style={[TTTypography.small,{color:selected?colors.link:colors.ink}]}>{label}</Text></Pressable>;
  const placementLabel=(payload:AnnotationPayload)=>{const status=ocr.placement(payload);return status&&<Text style={[TTTypography.caption,{color:colors.muted}]}>{ocrPlacementCopy[status].label}</Text>;};
  const placementNotice=(payload:AnnotationPayload)=>{const status=ocr.placement(payload);return status&&<TTNoticeCard title={ocrPlacementCopy[status].label} message={ocrPlacementCopy[status].message}/>;};
  const summary=(payload:AnnotationPayload)=><View style={{gap:8}}>
    {!!payload.title&&<Text selectable style={[TTTypography.bodyStrong,{color:colors.ink}]}>{payload.title}</Text>}
    {payload.anchor?.kind==='text'&&<Text selectable style={[TTTypography.small,{color:colors.muted}]}>{payload.anchor.quote}</Text>}
    <Text selectable style={[TTTypography.body,{color:colors.ink}]}>{payload.body||'Highlight without a note.'}</Text>
    <Text style={[TTTypography.caption,{color:colors.muted}]}>{noteContext(payload)} · {payload.color[0].toUpperCase()+payload.color.slice(1)}</Text>
    {placementNotice(payload)}
  </View>;
  return <View style={{gap:16}}>
    <View style={{flexDirection:'row',flexWrap:'wrap',alignItems:'center',gap:8}}>
      <Text accessibilityRole="header" style={[TTTypography.section,{color:colors.ink,flex:1}]}>{showTrash?'Trash':view==='highlights'?'Highlights':documentId?'Document notes':'Notes'}</Text>
      {view==='notes'&&!showTrash&&<TTButton label="New note" variant="secondary" disabled={!controller||busy} onPress={()=>void createNote()}/>}
      <TTButton label={showTrash?'Back to saved notes':'Notes Trash'} variant="ghost" accessibilityState={{expanded:showTrash}} onPress={()=>{setShowTrash(!showTrash);setDetailsId(null);}}/>
    </View>
    <TTSearchInput accessibilityLabel={view==='notes'?'Search notes':'Search highlights'} hintText="Search title, note or passage" value={query} onChangeText={setQuery}/>
    {!documentId&&<View style={{gap:8}}><Text style={[TTTypography.small,{color:colors.muted}]}>Context</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
      {([['all','All contexts'],['notebook','Notebook'],['documents','Documents']] as const).map(([value,label])=>toggle(label,context===value,()=>setContext(value)))}
    </View></View>}
    <View style={{gap:8}}><Text style={[TTTypography.small,{color:colors.muted}]}>Color</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
      {(['all','yellow','green','blue','purple'] as const).map(value=>toggle(value==='all'?'All colors':value[0].toUpperCase()+value.slice(1),color===value,()=>setColor(value)))}
    </View></View>
    <Text accessibilityLiveRegion="polite" style={[TTTypography.small,{color:colors.muted}]}>{state.message}</Text>
    {controller?.context.account&&<View style={{gap:8}}><Text style={[TTTypography.caption,{color:colors.muted}]}>{state.pending} pending · {state.lastSyncedAt?`Last synced ${new Date(state.lastSyncedAt).toLocaleString()}`:'Not synced yet'}</Text>
      <TTButton label={state.phase==='syncing'?'Syncing notes…':'Sync notes'} variant="ghost" widthPolicy="responsiveAction" disabled={state.phase==='syncing'||state.phase==='waiting'} onPress={()=>void controller.sync()}/></View>}
    {controller?.context.account&&!documentId&&view==='notes'&&!showTrash&&<View style={{gap:8}}>
      <TTButton label="Copy Guest notes to my account" variant="ghost" widthPolicy="responsiveAction" disabled={busy} onPress={()=>{setConfirmCopy(true);setCopyResult('');}}/>
      {confirmCopy&&<TTCard style={{gap:12}}>
        <Text style={[TTTypography.bodyStrong,{color:colors.ink}]}>Copy to {controller.context.accountLabel??'your signed-in account'}?</Text>
        <Text style={[TTTypography.small,{color:colors.muted}]}>Copies saved Guest notes and highlights, including their quoted text and attached original files, into this account. Guest originals, drafts and Trash stay on this device. Only copy material that belongs to this account. Existing copies are not duplicated.</Text>
        <TTButton label="Copy Guest notes and files" disabled={busy||state.phase==='loading'} isLoading={busy} onPress={()=>void act(async()=>{const count=await controller.copyGuest(createAnnotationPort('guest'));setCopyResult(count?`${count} Guest note${count===1?'':'s'} copied to this account and queued to sync.`:'No new Guest notes to copy. Existing copies are unchanged.');setConfirmCopy(false);})}/>
        <TTButton label="Cancel Guest copy" variant="ghost" disabled={busy} onPress={()=>setConfirmCopy(false)}/>
      </TTCard>}
      {!!copyResult&&<Text accessibilityLiveRegion="polite" style={[TTTypography.small,{color:colors.muted}]}>{copyResult}</Text>}
    </View>}
    {state.phase==='loading'&&<ActivityIndicator accessibilityLabel="Loading notes" color={colors.link}/>}
    {state.phase==='error'&&<TTNoticeCard type="error" title="Notes need attention" message={state.message} actionLabel="Retry notes" onActionPressed={()=>void(controller?.context.account?controller.sync():controller?.refresh())}/>}
    {!!error&&<TTNoticeCard type="error" title="Change not saved" message={error}/>}
    {!!ocr.warning&&<TTNoticeCard title="OCR placement unavailable" message={ocr.warning}/>}
    {unavailable>0&&<View style={{gap:8}}><Text style={[TTTypography.small,{color:colors.muted}]}>{unavailable} saved item{unavailable===1?'':'s'} belong to a document in Trash or unavailable on this account. Restore the original document before editing.</Text>
      <TTButton label={showUnavailable?'Hide unavailable documents':'Show unavailable documents'} accessibilityState={{expanded:showUnavailable}} variant="ghost" widthPolicy="responsiveAction" onPress={()=>setShowUnavailable(!showUnavailable)}/></View>}
    {!!drafts.length&&<View style={{gap:8}}><Text accessibilityRole="header" style={[TTTypography.bodyStrong,{color:colors.ink}]}>Drafts on this device</Text>
      {drafts.map(draft=><TTCard key={draft.id} style={{gap:8}}><Text style={[TTTypography.bodyStrong,{color:colors.ink}]}>{noteTitle(draft.payload)}</Text><Text style={[TTTypography.small,{color:colors.muted}]}>{noteContext(draft.payload)} · Not yet saved</Text>
        {placementLabel(draft.payload)}
        <TTButton label="Resume draft" semanticLabel={`Resume draft: ${noteTitle(draft.payload)}`} variant="secondary" disabled={busy} onPress={()=>void openDraft(draft.payload)}/></TTCard>)}
    </View>}
    {entries.map(item=><TTCard key={item.id} style={{gap:8,borderLeftWidth:4,borderLeftColor:noteColors[item.payload.color]}}>
      <Text style={[TTTypography.bodyStrong,{color:colors.ink}]}>{noteTitle(item.payload)}</Text>
      {item.payload.anchor?.kind==='text'&&<Text numberOfLines={3} style={[TTTypography.small,{color:colors.muted}]}>{item.payload.anchor.quote}</Text>}
      <Text style={[TTTypography.caption,{color:colors.muted}]}>{noteContext(item.payload)} · {item.payload.color[0].toUpperCase()+item.payload.color.slice(1)} · {syncLabels[item.syncStatus]}{item.parentDeleted?' · Document unavailable':''}</Text>
      {placementLabel(item.payload)}
      <TTButton label={item.conflict?'Compare versions':showTrash?'View trashed note':'Open note'} semanticLabel={`${item.conflict?'Compare versions':'Open note'}: ${noteTitle(item.payload)}`} variant="secondary" onPress={()=>{ocr.recheck();setDetailsId(item.id);setConfirmTrash(false);setError('');}}/>
    </TTCard>)}
    {(state.phase==='local'||state.phase==='ready')&&!entries.length&&!drafts.length&&<TTEmptyState title={showTrash?'No matching items in Trash':query.trim()||context!=='all'||color!=='all'?'No matching notes':view==='highlights'?'No highlights yet':'No notes yet'} message={showTrash?'Deleted notes and highlights can be restored here.':view==='highlights'?'Select a passage in a document, then choose Note to save a highlight.':'Write a notebook note, or select a passage in a document to attach a note.'}
      actionLabel={query.trim()||context!=='all'||color!=='all'?'Clear note filters':showTrash?'Back to saved notes':view==='highlights'?'Open My Syllabi':'Create note'}
      onAction={()=>{if(query.trim()||context!=='all'||color!=='all'){setQuery('');setContext('all');setColor('all');}else if(showTrash)setShowTrash(false);else if(view==='highlights')router.navigate('/(tabs)/library');else void createNote();}}/>}
    <Text style={[TTTypography.caption,{color:colors.muted}]}>{controller?.context.account?'Saved account notes and their quoted passages synchronize privately.':'Guest notes stay on this device.'} Search sends only your reviewed topic query.</Text>
    {details&&!editor&&<Modal visible animationType="slide" onRequestClose={()=>{if(!busy)setDetailsId(null);}}><TTScreen variant="form"><TTAppBar title={details.conflict?'Compare note versions':'Saved note'} leading={<TTIconButton icon={<TTFigmaIcon name="back" tintColor={colors.link}/>} semanticLabel="Close saved note" disabled={busy} onPress={()=>setDetailsId(null)}/>}/>
      <ScrollView contentContainerStyle={{padding:16,gap:16}} keyboardShouldPersistTaps="handled">
        <TTButton label="Close note" variant="ghost" disabled={busy} onPress={()=>setDetailsId(null)}/>
        {summary(details.payload)}
        {!!ocr.warning&&<TTNoticeCard title="OCR placement unavailable" message={ocr.warning}/>}
        <Text style={[TTTypography.small,{color:colors.muted}]}>{syncLabels[details.syncStatus]}</Text>
        {!!error&&<TTNoticeCard type="error" title="Change not saved" message={error}/>}
        {details.parentDeleted&&<TTNoticeCard title="Original document unavailable" message="This note is preserved. Restore the original document from Library details before editing or returning to its passage."/>}
        {details.conflict?<View style={{gap:16}}>
          <TTCard style={{gap:8}}><Text accessibilityRole="header" style={[TTTypography.section,{color:colors.ink}]}>Cloud version{details.conflict.cloud.revision===0?' · Not yet saved in cloud':details.conflict.cloud.deleted?' · In Trash':''}</Text>{details.conflict.cloud.revision===0?<Text style={[TTTypography.small,{color:colors.muted}]}>There is no saved cloud version of this note.</Text>:summary(details.conflict.cloud.payload)}</TTCard>
          <TTCard style={{gap:8}}><Text accessibilityRole="header" style={[TTTypography.section,{color:colors.ink}]}>This device{details.conflict.local.action==='remove'?' · Move to Trash':''}</Text>{summary(details.conflict.local.payload)}</TTCard>
          {details.conflict.cloud.deleted&&details.conflict.cloud.revision>0&&<Text style={[TTTypography.small,{color:colors.muted}]}>The cloud note stays in Trash. Keep cloud to accept that change. Keep both deliberately creates a separate note from this device’s text when available.</Text>}
          <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{(['cloud','local','both'] as const).map(choice=>{const allowed=conflictChoices(details);return <TTButton key={choice} label={choice==='cloud'?'Keep cloud':choice==='local'?'Keep this device':'Keep both'} disabled={busy||!controller||!allowed[choice]} variant={choice==='cloud'?'secondary':'primary'} onPress={()=>void act(()=>controller!.run(store=>store.resolve(details.id,choice)),true)}/>;})}</View>
        </View>:<View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
          {details.deleted?<TTButton label="Restore note" disabled={busy||details.parentDeleted||!controller} onPress={()=>void act(()=>controller!.run(store=>store.restore(details.id)),true)}/>:<>
            <TTButton label="Edit note" disabled={busy||details.parentDeleted} onPress={()=>{setEditorFallback(undefined);setEditor(details.payload);}}/>
            <TTButton label="Move to Trash" variant="ghost" disabled={busy||details.parentDeleted} onPress={()=>setConfirmTrash(true)}/>
          </>}
          {!!details.payload.documentId&&<TTButton label="Go to passage" variant="secondary" disabled={busy||details.parentDeleted||details.deleted} onPress={()=>reveal(details)}/>}
        </View>}
        {confirmTrash&&<TTCard style={{gap:8}}><Text style={[TTTypography.body,{color:colors.ink}]}>Move this note{details.payload.anchor?' and its highlight':''} to Trash? You can restore it here.</Text>
          <TTButton label="Confirm Move to Trash" variant="danger" disabled={busy} onPress={()=>void act(()=>controller!.run(store=>store.remove(details.id)),true)}/><TTButton label="Cancel" variant="ghost" disabled={busy} onPress={()=>setConfirmTrash(false)}/></TTCard>}
      </ScrollView></TTScreen></Modal>}
    {editor&&<NoteEditor key={editor.id} initial={editor} item={editorItem} ocrPlacements={ocrPlacements} startEditing onClose={()=>setEditor(null)} onReveal={editorItem?.payload.documentId&&!editorItem.parentDeleted?()=>reveal(editorItem):undefined}/>}
  </View>;
}
