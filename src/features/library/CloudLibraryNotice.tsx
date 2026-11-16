import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { TTButton, TTCard } from '../../components';
import { useColors } from '../../core/theme/ThemeContext';
import { TTTypography } from '../../core/design/tokens';
import { useCloudLibrary } from './CloudLibraryContext';
import { bookmarkStore } from '../../core/services/bookmarks/storage';
import type { Document } from '../../core/models/document';
import { CloudStudyConflicts } from './CloudStudyConflicts';

export function CloudLibraryNotice() {
  const {state}=useCloudLibrary();
  return <CloudLibraryNoticeContent key={state.epoch} />;
}
function CloudLibraryNoticeContent() {
  const router = useRouter();
  const {runtime,state}=useCloudLibrary(); const {colors}=useColors();
  const [legacyCount,setLegacyCount]=useState(0); const [copying,setCopying]=useState(false); const [error,setError]=useState('');
  const [trashed,setTrashed]=useState<Document[]>([]);const [showTrash,setShowTrash]=useState(false);
  const [expanded,setExpanded]=useState(false);
  useEffect(()=>{let active=true;
    if(state.identity)void runtime?.legacyCount().then(count=>{if(active)setLegacyCount(count);}).catch(()=>{if(active)setError('Existing device files could not be read. They have not been changed.');});
    return()=>{active=false;};},[runtime,state.epoch,state.identity]);
  useEffect(()=>{let active=true;if(state.identity&&runtime)void runtime.trashedDocuments().then(docs=>{if(active)setTrashed(docs);}).catch(()=>{if(active)setError('Trash could not be loaded. Your files have not been changed.');});return()=>{active=false;};},[runtime,state.epoch,state.revision,state.identity]);
  async function copy(){if(!runtime)return;setCopying(true);setError('');try{await runtime.copyLegacy();}catch(reason){setError(reason instanceof Error?reason.message:'Could not copy device files. Originals are unchanged.');}finally{setCopying(false);}}
  async function copyBookmarks(){if(!runtime)return;setCopying(true);setError('');try{const target=runtime.bookmarks();await bookmarkStore.initialize();for(const bookmark of bookmarkStore.getSnapshot().bookmarks)await target.save(bookmark);}catch(reason){setError(reason instanceof Error?reason.message:'Some bookmarks could not be copied. Originals are unchanged.');}finally{setCopying(false);}}
  async function restore(id:string){if(!runtime)return;setCopying(true);setError('');try{await runtime.restoreDocument(id);}catch(reason){setError(reason instanceof Error?reason.message:'Could not restore this file.');}finally{setCopying(false);}}
  const account=Boolean(state.identity);
  return <TTCard padding={16}><View style={{gap:10}}>
    <Text style={[TTTypography.bodyStrong,{color:colors.ink}]}>{account?'Account cloud library':'Device library'}</Text>
    <Text accessibilityLiveRegion="polite" style={[TTTypography.small,{color:state.phase==='error'?colors.ink:colors.muted}]}>{state.message}</Text>
    {account&&<Text style={[TTTypography.caption,{color:colors.muted}]}>{state.pending} pending · {state.lastSyncedAt ? `Last synced ${new Date(state.lastSyncedAt).toLocaleString()}` : 'Not synced yet'}</Text>}
    <TTButton label={expanded?'Hide library details':'Library details'} accessibilityState={{expanded}} variant="ghost" widthPolicy="responsiveAction" onPress={()=>setExpanded(!expanded)} />
    {expanded&&<>
    {account?<>
      <Text style={[TTTypography.small,{color:colors.muted}]}>{runtime?.accountLabel() ?? 'Your signed-in account'} · New documents sync automatically. Open TopicTrail with this account on your other device to download them.</Text>
      <TTButton label={state.phase==='syncing'?'Syncing documents…':'Sync now'} variant="secondary" widthPolicy="responsiveAction" disabled={state.phase==='syncing'||state.phase==='waiting'||copying} onPress={()=>{void runtime?.sync();}} />
      {legacyCount>0&&<>
        <Text style={[TTTypography.small,{color:colors.muted}]}>{legacyCount} existing device file{legacyCount===1?'':'s'} can be copied to this account. The originals stay on this device. Only copy files that belong to this account.</Text>
        <TTButton label="Copy device files to my account" widthPolicy="responsiveAction" isLoading={copying} disabled={state.phase==='syncing'} onPress={()=>{void copy();}} />
      </>}
      <TTButton label="Copy device bookmarks to my account" widthPolicy="responsiveAction" disabled={copying} onPress={()=>{void copyBookmarks();}} />
      <Text style={[TTTypography.small,{color:colors.muted}]}>Bookmarks, reading positions, renamed titles and Trash changes synchronize when connected. Original files are retained. Changes stay queued on this device until sync succeeds.</Text>
      <TTButton label={`${showTrash?'Hide':'Show'} Trash (${trashed.length})`} accessibilityState={{expanded:showTrash}} variant="secondary" onPress={()=>setShowTrash(!showTrash)} />
      {showTrash&&trashed.map(doc=><View key={doc.id} style={{gap:6}}><Text style={[TTTypography.small,{color:colors.ink}]}>{doc.title}</Text><TTButton label={`Restore ${doc.title}`} disabled={copying} variant="secondary" onPress={()=>{void restore(doc.id);}} /></View>)}
      <CloudStudyConflicts />
    </>:<>
      <Text style={[TTTypography.small,{color:colors.muted}]}>Your existing files stay on this device. Sign in to copy them to your account and access them elsewhere.</Text>
      <TTButton label="Sign in for cloud sync" variant="secondary" widthPolicy="responsiveAction" onPress={()=>router.push('/auth/login')} />
    </>}
    </>}
    {!!error&&<Text accessibilityRole="alert" style={[TTTypography.small,{color:colors.ink}]}>{error}</Text>}
  </View></TTCard>;
}
