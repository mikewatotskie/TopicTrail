import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import type { Document } from '../../core/models/document';
import type { AnnotationListItem, AnnotationPayload, RegionAnchorV1, TextAnchorV1 } from '../../core/services/annotations/types';
import type { ReaderConnection } from '../reader/reader_channel';
import type { AnnotationPlacement, ReaderMessage } from '../reader/selection';
import { useTheme } from '../../core/theme/ThemeContext';
import { TTButton, TTNoticeCard } from '../../components';
import { useNotes } from './NotesProvider';
import { NoteEditor } from './NoteEditor';
import { NotesPanel } from './NotesPanel';
import { matchingNotes, newNotePayload } from './note_selection';
import { ReaderNoteSession } from './reader_note_session';
import { validateReaderAnnotations } from '../reader/reader_protocol';
import { ocrPlacementCopy, ocrPlacementKey, type OcrRenderPlacements } from './ocrPlacement';
import { useOcrNotePlacements } from './ocrPlacementHooks';

export function useReaderNotes(document:Document|null,hash:string,page:number,viewer:React.RefObject<ReaderConnection|null>,changePage:(page:number)=>void){
  const {state,controller}=useNotes(),{colors}=useTheme(),{annotationId}=useLocalSearchParams<{annotationId?:string}>();
  const session=useRef(new ReaderNoteSession()),navigate=useRef(changePage),routeSeen=useRef(''),totalPages=useRef(1);
  useLayoutEffect(()=>{navigate.current=changePage;},[changePage]);
  const [hasAnchor,setHasAnchor]=useState(false);
  const [editor,setEditor]=useState<AnnotationPayload|null>(null),[detailsId,setDetailsId]=useState<string|null>(null);
  const [regionPreview,setRegionPreview]=useState<AnnotationPayload|null>(null),[areaBusy,setAreaBusy]=useState(false);
  const areaLock=useRef(false),lastAreaMode=useRef<'drag'|'corners'>('drag');
  const [chooser,setChooser]=useState<AnnotationListItem[]>([]),[panel,setPanel]=useState(false),[warning,setWarning]=useState(''),[revision,setRevision]=useState(0),[areaMode,setAreaMode]=useState<'drag'|'corners'|null>(null);
  const [placements,setPlacements]=useState<{documentId:string;hash:string;page:number;serialized:string;items:AnnotationPlacement[];ocr:OcrRenderPlacements}|null>(null);
  const refresh=()=>setRevision(value=>value+1);
  const current=state.items.filter(item=>!item.deleted&&!item.parentDeleted&&item.payload.documentId===document?.id&&item.payload.documentHash===hash&&item.payload.location?.index===page&&!!item.payload.anchor);
  const serialized=JSON.stringify(current.map(item=>({id:item.id,anchor:item.payload.anchor!,color:item.payload.color,hasNote:!!item.payload.body.trim()})));
  const rendered=placements?.ocr.owner===controller?.context&&placements?.documentId===document?.id&&placements?.hash===hash&&placements?.page===page&&placements?.serialized===serialized?placements:null;
  const details=state.items.find(item=>item.id===detailsId);
  const ocr=useOcrNotePlacements([...current.map(item=>item.payload),...(details?[details.payload]:[])],controller?.context,rendered?.ocr);
  const detailsPlacement=details&&ocr.placement(details.payload);
  const overlayWarning=validateReaderAnnotations(JSON.parse(serialized))?'':'This page has too many highlights to display. They remain available in Notes.';
  useEffect(()=>{
    if(session.current.page!==page||overlayWarning)return;
    viewer.current?.setAnnotations(JSON.parse(serialized));
  },[viewer,serialized,revision,page,overlayWarning]);
  useEffect(()=>{
    if(annotationId&&routeSeen.current!==annotationId){routeSeen.current=annotationId;session.current.requestReveal(annotationId,true);}
    const id=session.current.target;if(!id||!document||!viewer.current)return;
    const item=state.items.find(i=>i.id===id);if(!item)return;
    if(item.deleted||item.parentDeleted||item.payload.documentId!==document.id||item.payload.documentHash!==hash){
      session.current.cancelReveal();setWarning('This note belongs to an unavailable document or another version of the original file.');return;
    }
    const action=session.current.advance(item.payload.location?.index??null,totalPages.current);
    if(action.type==='navigate')navigate.current(action.page);
    else if(action.type==='reveal'){viewer.current.revealAnnotation(action.id);if(action.open)setDetailsId(action.id);}
    else if(action.type==='unavailable')setWarning('The saved location is outside this document. The note is still available in Notes.');
  },[annotationId,document,hash,page,revision,state.items,viewer]);
  const make=(value:TextAnchorV1|RegionAnchorV1|null,location=true):AnnotationPayload|null=>document&&hash&&session.current.page!==null?{...newNotePayload(),documentId:document.id,documentHash:hash,format:document.format,location:location?{unit:document.format==='pdf'?'page':document.format==='pptx'?'slide':'section',index:session.current.page}:null,anchor:value}:null;
  function openNote(){
    const anchor=session.current.consume(),location=session.current.page;
    if(!anchor||!document||location===null){setWarning('Select a shorter passage in one text surface to attach a note.');return;}
    const found=matchingNotes(state.items,document.id,hash,location,anchor);
    if(found.length>1)setChooser(found);else if(found.length===1)setDetailsId(found[0].id);else setEditor(make(anchor));
  }
  function receive(message:ReaderMessage){
    session.current.receive(message);
    setHasAnchor(!!session.current.anchor);
    if(message.type==='render-start'||message.type==='surface-change'){setPlacements(null);setAreaMode(null);refresh();}
    else if(message.type==='page'){totalPages.current=message.totalPages;refresh();}
    else if(message.type==='selection'&&message.page===session.current.page&&message.text){setWarning(message.annotationUnavailable??'');refresh();}
    else if(message.type==='selection-limit'||message.type==='selection-reset')refresh();
    else if(message.type==='area-preview'&&message.page===session.current.page){setAreaMode(null);setRegionPreview(make(message.anchor));}
    else if(message.type==='area-cancelled'){setAreaMode(null);setRegionPreview(null);}
    else if(message.type==='annotation-placements'&&message.page===session.current.page&&document&&controller){
      const items=message.placements.filter(placement=>current.some(item=>item.id===placement.id));
      setPlacements({documentId:document.id,hash,page:message.page,serialized,items,ocr:{owner:controller.context,checks:items.flatMap(placement=>{
        const item=current.find(item=>item.id===placement.id)!,key=ocrPlacementKey(item.payload);
        return key?[{key,status:placement.status}]:[];
      })}});
    }
    else if(message.type==='error'){setAreaMode(null);setRegionPreview(null);setPlacements(null);refresh();}
  }
  const reveal=(item:AnnotationListItem,open=false)=>{setPanel(false);setDetailsId(null);session.current.requestReveal(item.id,open);refresh();};
  const mark=(mode:'drag'|'corners')=>{lastAreaMode.current=mode;setRegionPreview(null);setAreaMode(mode);viewer.current?.markArea(mode);};
  const close=()=>{setEditor(null);setRegionPreview(null);viewer.current?.cancelArea();setAreaMode(null);viewer.current?.focus();};
  async function saveArea(){
    if(!regionPreview||!controller||areaLock.current)return;areaLock.current=true;setAreaBusy(true);setWarning('');
    try{await controller.run(store=>store.save(regionPreview,{highlightOnly:true}));setRegionPreview(null);viewer.current?.cancelArea();viewer.current?.focus();}
    catch(reason){setWarning(reason instanceof Error?reason.message:'The area highlight could not be saved. Retry.');}
    finally{areaLock.current=false;setAreaBusy(false);}
  }
  const content=<>
    {!!(warning||overlayWarning)&&<TTNoticeCard title="Notes and highlights" message={warning||overlayWarning}/>}
    {(rendered?.items.some(p=>p.status==='needs-review')||current.some(item=>ocr.placement(item.payload)==='needs-review'))&&<TTNoticeCard title="Needs review" message="Some highlights could not be placed reliably. OCR text can differ between devices or engines. The notes and saved passages are preserved; their highlights were not guessed."/>}
    {rendered?.items.some(p=>p.status==='recognize-page')&&<TTNoticeCard title="Recognize page" message="Recognize this page to check its OCR highlights. The saved notes remain available."/>}
    {!!ocr.warning&&<TTNoticeCard title="OCR placement unavailable" message={ocr.warning}/>}
    {!!areaMode&&<View style={{padding:8,gap:8}}><Text style={{color:colors.ink}}>{areaMode==='drag'?'Drag a rectangle on the PDF page.':'Tap the two opposite corners on the PDF page.'} Keyboard: arrow keys move the corner; Enter selects; Escape cancels.</Text><TTButton label="Cancel area selection" variant="ghost" onPress={()=>{viewer.current?.cancelArea();setAreaMode(null);}}/></View>}
    {!!regionPreview&&!editor&&<View style={{padding:8,gap:8}}><Text accessibilityLiveRegion="polite" style={{color:colors.ink}}>Area preview — review the outlined rectangle on the PDF before saving.</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
      <TTButton label="Save area highlight" disabled={areaBusy||!controller} isLoading={areaBusy} onPress={()=>void saveArea()}/>
      <TTButton label="Add note or color" variant="secondary" disabled={areaBusy} onPress={()=>setEditor(regionPreview)}/>
      <TTButton label="Redraw area" variant="ghost" disabled={areaBusy} onPress={()=>mark(lastAreaMode.current)}/>
      <TTButton label="Cancel area preview" variant="ghost" disabled={areaBusy} onPress={()=>{setRegionPreview(null);viewer.current?.cancelArea();viewer.current?.focus();}}/>
    </View></View>}
    {!!editor&&<NoteEditor key={editor.id} initial={editor} item={state.items.find(i=>i.id===editor.id)} ocrPlacements={rendered?.ocr} startEditing onClose={close} onRedraw={editor.anchor?.kind==='region'&&!state.items.some(i=>i.id===editor.id)?()=>mark(lastAreaMode.current):undefined}/>}
    {!!details&&!editor&&<Modal visible transparent onRequestClose={()=>{setDetailsId(null);viewer.current?.focus();}}><View style={{flex:1,padding:20,justifyContent:'center',backgroundColor:'#0008'}}><ScrollView style={{maxHeight:'85%',backgroundColor:colors.surface,borderRadius:16}} contentContainerStyle={{padding:20,gap:16}}>
      <Text accessibilityRole="header" style={{color:colors.ink,fontSize:22}}>{details.payload.title||'Saved note'}</Text>
      {details.payload.anchor?.kind==='text'&&<Text selectable style={{color:colors.muted}}>{details.payload.anchor.quote}</Text>}
      {!!detailsPlacement&&<TTNoticeCard title={ocrPlacementCopy[detailsPlacement].label} message={ocrPlacementCopy[detailsPlacement].message}/>}
      {!!ocr.warning&&<TTNoticeCard title="OCR placement unavailable" message={ocr.warning}/>}
      <Text selectable style={{color:colors.ink}}>{details.payload.body||'Highlight without a note.'}</Text><Text style={{color:colors.muted}}>{details.payload.color[0].toUpperCase()+details.payload.color.slice(1)} highlight</Text>
      <TTButton label="Edit note or color" disabled={details.parentDeleted||!!details.conflict} onPress={()=>{setDetailsId(null);setEditor(details.payload);}}/>
      <TTButton label="Go to passage" variant="secondary" disabled={details.parentDeleted} onPress={()=>reveal(details)}/>
      <TTButton label="Close note" variant="ghost" onPress={()=>{setDetailsId(null);viewer.current?.focus();}}/>
    </ScrollView></View></Modal>}
    {!!chooser.length&&<Modal visible transparent onRequestClose={()=>setChooser([])}><View style={{flex:1,padding:20,justifyContent:'center',backgroundColor:'#0008'}}><ScrollView style={{maxHeight:'80%',backgroundColor:colors.surface,borderRadius:16}} contentContainerStyle={{padding:16,gap:12}}><Text accessibilityRole="header" style={{color:colors.ink,fontSize:20}}>Choose the overlapping note</Text>{chooser.map(item=>{const placement=ocr.placement(item.payload);return <View key={item.id} style={{gap:4}}><TTButton label={item.payload.title||item.payload.body||'Highlight without a note'} variant="secondary" onPress={()=>{setDetailsId(item.id);setChooser([]);}}/>{placement&&<Text style={{color:colors.muted}}>{ocrPlacementCopy[placement].label}</Text>}</View>;})}<TTButton label="Cancel" variant="ghost" onPress={()=>setChooser([])}/></ScrollView></View></Modal>}
    {panel&&<Modal visible animationType="slide" onRequestClose={()=>{setPanel(false);viewer.current?.focus();}}><View style={{flex:1,backgroundColor:colors.canvas,padding:16,gap:8}}><TTButton label="Return to reading" variant="secondary" onPress={()=>{setPanel(false);viewer.current?.focus();}}/><NotesPanel documentId={document?.id} ocrPlacements={rendered?.ocr} onReveal={item=>reveal(item)}/></View></Modal>}
  </>;
  return {receive,openNote,captureNote:()=>session.current.capture(),canNote:hasAnchor&&!!controller,
    clear:()=>{session.current.clear();setHasAnchor(false);refresh();},beforeNavigation:(preserveArea=false)=>{session.current.beginNavigation();setHasAnchor(false);setPlacements(null);setAreaMode(null);if(!preserveArea)setRegionPreview(null);refresh();},
    openPanel:()=>setPanel(true),newDocumentNote:()=>setEditor(make(null,false)),newLocationNote:()=>setEditor(make(null)),mark,content};
}
