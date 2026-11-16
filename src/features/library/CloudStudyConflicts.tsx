import React,{useEffect,useState} from 'react';
import {Text,View} from 'react-native';
import {TTButton,TTCard} from '../../components';
import {useColors} from '../../core/theme/ThemeContext';
import {TTTypography} from '../../core/design/tokens';
import type {StudyConflict} from '../../core/services/cloud/study_state';
import {useCloudLibrary} from './CloudLibraryContext';

function describe(payload:Record<string,unknown>){return typeof payload.title==='string'?payload.title:typeof payload.page==='number'?`Position ${payload.page} of ${payload.totalPages}`:'Removed item';}
function choiceLabel(conflict:StudyConflict,choice:'local'|'cloud') {
  const side=choice==='cloud'?'cloud':'this device’s';
  if(conflict.kind==='progress')return `Keep ${side} reading position`;
  if(conflict.kind==='document')return choice==='cloud'&&conflict.cloud.deleted?'Keep in Trash':choice==='local'&&conflict.local.action==='remove'?'Move to Trash':`Keep ${side} document name`;
  return choice==='cloud'&&conflict.cloud.deleted?'Keep bookmark removed':choice==='local'&&conflict.local.action==='remove'?'Remove bookmark':`Keep ${side} bookmark`;
}
export function CloudStudyConflicts({documentId,onResolved}:{documentId?:string;onResolved?:()=>void}){
  const {runtime,state}=useCloudLibrary();const {colors}=useColors();
  const [loaded,setConflicts]=useState<{epoch:number;conflicts:StudyConflict[]}>({epoch:-1,conflicts:[]});const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;if(state.identity&&runtime)void runtime.studyState().then(value=>{if(active)setConflicts({epoch:state.epoch,conflicts:value.conflicts.filter(c=>!documentId||(c.kind==='progress'&&c.id===documentId))});}).catch(()=>{if(active)setError('Cloud choices could not be loaded. Your local changes are preserved.');});return()=>{active=false;};},[runtime,state.epoch,state.revision,state.identity,documentId]);
  async function choose(conflict:StudyConflict,choice:'local'|'cloud'){
    if(!runtime||busy||runtime.getSnapshot().epoch!==state.epoch)return;setBusy(true);setError('');
    try{await runtime.resolveConflict(conflict.kind,conflict.id,choice);onResolved?.();}catch(reason){setError(reason instanceof Error?reason.message:'Could not save your choice.');}finally{setBusy(false);}
  }
  const conflicts=state.identity&&loaded.epoch===state.epoch?loaded.conflicts:[];
  return <View style={{gap:8}}>{conflicts.map(conflict=><TTCard key={conflict.kind+conflict.id} padding={16}><View style={{gap:8}}>
    <Text style={[TTTypography.bodyStrong,{color:colors.ink}]}>{conflict.kind==='progress'?'Choose where to resume':'Choose which change to keep'}</Text>
    <Text selectable style={[TTTypography.small,{color:colors.muted}]}>Cloud: {conflict.cloud.deleted?'Removed':describe(conflict.cloud.payload)}{'\n'}This device: {describe(conflict.local.payload)}</Text>
    <TTButton label={choiceLabel(conflict,'cloud')} disabled={busy} variant="secondary" onPress={()=>{void choose(conflict,'cloud');}} />
    {!conflict.cloud.deleted&&<TTButton label={choiceLabel(conflict,'local')} disabled={busy} onPress={()=>{void choose(conflict,'local');}} />}
    {conflict.cloud.deleted&&<Text style={[TTTypography.small,{color:colors.muted}]}>A removed item stays removed. Keep the cloud version, then use Restore in Trash or explicitly save the bookmark again.</Text>}
  </View></TTCard>)}{!!error&&<Text accessibilityRole="alert" style={[TTTypography.small,{color:colors.ink}]}>{error}</Text>}</View>;
}
