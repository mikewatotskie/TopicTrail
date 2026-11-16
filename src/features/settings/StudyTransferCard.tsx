import React, {useRef, useState} from 'react';
import {Platform, Text, TextInput} from 'react-native';
import {TTButton, TTCard} from '../../components';
import {TTTypography} from '../../core/design/tokens';
import {useTheme} from '../../core/theme/ThemeContext';
import {useAuth} from '../auth/AuthContext';
import {studyTransferNative} from '../../core/services/study_transfer_native';

export function StudyTransferCard() {
  const {colors} = useTheme();
  const {state, gateway} = useAuth();
  const scope = state.status === 'account' ? state.account.uid : state.status;
  const role = studyTransferNative().role;
  if (Platform.OS !== 'android' || role === 'unavailable' || (state.status !== 'account' && state.status !== 'guest')) return null;
  return <TransferFields key={scope} edition={role} label={state.status === 'account' ? state.account.email ?? 'this account' : 'Guest'}
    gateway={gateway} colors={colors}/>;
}
function TransferFields({edition,label,gateway,colors}: {
  edition:'legacy'|'production';label:string;gateway:ReturnType<typeof useAuth>['gateway'];colors:ReturnType<typeof useTheme>['colors'];
}) {
  const [action,setAction]=useState<'export'|'import'|null>(null);
  const [pass,setPass]=useState('');
  const [confirm,setConfirm]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const lock=useRef(false);
  function select(next: typeof action) {setAction(next);setMessage('');setPass('');setConfirm('');}
  async function run() {
    if (lock.current || !action) return;
    if (pass.length<12 || pass.length>1024) {setMessage('Use a passphrase of 12 to 1024 characters.');return;}
    if (action==='export' && pass!==confirm) {setMessage('The passphrases do not match.');return;}
    lock.current=true;setBusy(true);setMessage('');
    const secret=pass;setPass('');setConfirm('');
    try {
      const api=await import('../../core/services/transfer/device');
      const result=action==='export'?await api.exportStudyData(gateway,secret):await api.importStudyData(gateway,secret);
      const c=result.counts;
      const summary=c.documents+' documents ('+c.trash+' in Trash), '+c.originals+' originals, '+c.bookmarks+' bookmarks, '+c.progress+' reading positions, '+c.notes+' note records, '+c.drafts+' drafts, '+c.pending+' queued changes.';
      const missing=result.missing.length ? '\nMissing originals ('+result.missing.length+'). Keep the old app and relink these files:\n'+result.missing.join('\n') : '';
      const status='repeated' in result && result.repeated ? 'This archive was already imported.' : action==='export'?'Archive saved.':'Import complete.';
      setMessage(status+' '+summary+missing);setAction(null);
    } catch(error) {
      setMessage(error instanceof Error ? error.message : 'Transfer could not finish. Keep both installations and try again.');
    } finally {lock.current=false;setBusy(false);}
  }
  const style={...TTTypography.body,color:colors.ink,borderWidth:1,borderColor:colors.border,borderRadius:10,padding:12};
  const field=(label:string,value:string,setValue:(value:string)=>void)=><TextInput accessibilityLabel={label}
    placeholder={label} placeholderTextColor={colors.muted} style={style} value={value} onChangeText={setValue}
    autoComplete="off" importantForAutofill="no" autoCorrect={false} autoCapitalize="none" secureTextEntry maxLength={1024} editable={!busy}/>;
  return <TTCard borderRadius={16} style={{gap:10}}>
    <Text style={[TTTypography.section,{color:colors.ink}]}>Study data transfer</Text>
    <Text style={[TTTypography.small,{color:colors.muted}]}>Current library: {label}. Export Guest and each account separately on each phone. Keep your old app until you have checked the restored files.</Text>
    {!action ? <>
      <TTButton label="Export study data" variant="secondary" onPress={()=>select('export')}/>
      {edition==='production' && <TTButton label="Import study data" variant="secondary" onPress={()=>select('import')}/>}
    </> : <>
      <Text style={[TTTypography.small,{color:colors.muted}]}>{action==='export'?'Choose a passphrase and keep it somewhere safe. You will need it to open this archive.':'Use the archive passphrase. For an account archive, sign in to the matching account again before restoring.'}</Text>
      {field('Archive passphrase',pass,setPass)}
      {action==='export' && field('Confirm archive passphrase',confirm,setConfirm)}
      <TTButton label={busy?'Transferring…':action==='export'?'Choose where to save':'Choose archive'} disabled={busy} onPress={()=>void run()}/>
      <TTButton label="Cancel" variant="ghost" disabled={busy} onPress={()=>select(null)}/>
    </>}
    {!!message && <Text accessibilityLiveRegion="polite" selectable style={[TTTypography.small,{color:colors.ink}]}>{message}</Text>}
  </TTCard>;
}
