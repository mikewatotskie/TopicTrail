import React,{useCallback,useRef} from 'react';
import {View,Text,ScrollView,ActivityIndicator,Platform} from 'react-native';
import {router,useFocusEffect} from 'expo-router';
import {useColors} from '../../core/theme/ThemeContext';
import {TTTypography} from '../../core/design/tokens';
import {TTButton,TTNoticeCard,TTUploadDocumentCard,TTScreen,TTCard,TTInfoBanner,TTAura,TTFigmaIcon,TTIconButton} from '../../components';
import {TTAppBar} from '../../navigation';
import {useAuth} from '../auth/AuthContext';
import {goAuth} from '../auth/AuthForm';
import {useUploadSession} from './UploadSessionContext';
import {GuestUploadLimit} from './GuestUploadLimit';
import {subscribeLibraryChanges} from '../../core/services/web/library_events';
import {uploadAction} from './upload_session';
export function UploadScreen() {
 const {colors}=useColors();const {gateway}=useAuth();const {owner,state}=useUploadSession();
 const active=useRef(false);const focusGeneration=useRef(0);const submitting=useRef(false);
 useFocusEffect(useCallback(()=>{active.current=true;owner.ensure();void owner.refresh();
   let unsubscribe=()=>{};
   if(Platform.OS==='web') {
     const refresh=()=>{void owner.refresh()};
     const stop=subscribeLibraryChanges('documents',refresh);
     window.addEventListener('focus',refresh);
     const visible=()=>{if(document.visibilityState==='visible')refresh()};
     document.addEventListener('visibilitychange',visible);
     unsubscribe=()=>{stop();window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',visible)};
   }
   return()=>{active.current=false;focusGeneration.current++;unsubscribe();};
 },[owner]));
 function actor(){const state=gateway.getSnapshot();return state.status==='account'?{kind:'account' as const,uid:state.account.uid}:{kind:'guest' as const};}
 function pick(){void owner.pick(actor());}
 function cancel(){const snapshot=owner.getSnapshot();if(snapshot.processing||snapshot.picking)return;owner.cancel();if(router.canGoBack())router.back();else router.replace('/(tabs)/library');}
 function open(){if(state.result?.document)router.replace({pathname:'/reader/[documentId]',params:{documentId:state.result.document.id}});}
 function submit(){if(submitting.current)return;submitting.current=true;const focused=focusGeneration.current;const started=state.sessionId;void owner.submit(actor()).then(result=>{if(active.current&&focusGeneration.current===focused&&owner.matches(started??undefined)&&result?.success&&result.document&&result.code!=='committed')router.replace({pathname:'/reader/[documentId]',params:{documentId:result.document.id}});}).finally(()=>{submitting.current=false});}
 function auth(path:'/auth/login'|'/auth/register'){owner.dismissPrompt();goAuth(path,'upload',state.sessionId??undefined);}
 const action=uploadAction(state.result);const loading=state.allowance===null&&actor().kind==='guest';
 const selectedFile=state.asset;const processing=state.processing;const picking=state.picking;
 const footer=action==='open'?{label:'Open document',press:open}:action==='library'?{label:'Back to My Syllabi',press:()=>router.replace('/(tabs)/library')}:action==='reselect'?{label:'Choose another file',press:pick}:action==='conflict'?{label:'Try upload again',press:submit}:action==='retry'?{label:'Retry upload',press:submit}:{label:'Upload and continue',press:submit};
 const allowanceBlocks=actor().kind==='guest'&&(state.allowance?.kind==='recovery_required'||(state.allowance?.kind==='ready'&&state.allowance.remaining===0));
 return <TTScreen variant="form">
 <TTAura style={{right:-32,bottom:64}}/>
 <TTAppBar title={processing?'Preparing your syllabus':'Upload syllabus'} leading={<TTIconButton icon={<TTFigmaIcon name="back"/>} semanticLabel="Back from Upload" disabled={processing||picking} onPress={cancel}/>}/>
 <ScrollView contentContainerStyle={{padding:16,gap:16}}>
 {processing?<TTCard padding={24}><View style={{gap:16,alignItems:'center'}}><ActivityIndicator color={colors.link}/><Text style={[TTTypography.title,{color:colors.ink}]}>{'Preparing your syllabus\u2026'}</Text></View></TTCard>:<>
 {picking&&<Text style={[TTTypography.body,{color:colors.muted}]}>Waiting for the file chooser…</Text>}
 {loading?<Text style={[TTTypography.body,{color:colors.muted}]}>{'Checking upload allowance\u2026'}</Text>:<TTUploadDocumentCard isProcessing={picking} onTap={pick}/>}
 <TTCard>{!!selectedFile&&<View style={{marginBottom:8}}><TTFigmaIcon name="file" slot={32}/></View>}<Text style={[TTTypography.bodyStrong,{color:colors.ink}]}>{selectedFile?.name??'No file selected'}</Text><Text style={[TTTypography.small,{color:colors.muted,marginTop:8}]}>{selectedFile?(selectedFile.name.toLowerCase().endsWith('.docx')?'DOCX \u00b7 Text view':'PDF'):'Choose a PDF or DOCX to continue.'}</Text></TTCard>
 {state.result?.errorMessage&&<TTNoticeCard type="error" title={action==='conflict'?'Library changed in another window':action==='library'?'Document already deleted':'Unable to upload'} message={action==='conflict'?'Review the latest library state and try again.':state.result.errorMessage}/>}
 {allowanceBlocks&&<TTButton label="Check upload allowance" variant="secondary" onPress={()=>{void owner.refresh().then(()=>owner.check(actor()));}}/>}
 <TTInfoBanner message="Your syllabus stays on this device."/>
 </>}
 </ScrollView>
 <View style={{padding:16,gap:8,backgroundColor:colors.surface}}><TTButton label={footer.label} variant="study" isExpanded onPress={footer.press} disabled={loading||picking||(!selectedFile&&action!=='library'&&action!=='open'&&action!=='reselect')||(action==='conflict'&&allowanceBlocks)} isLoading={processing}/><TTButton label="Cancel" variant="ghost" isExpanded disabled={processing||picking} onPress={cancel}/></View>
 <GuestUploadLimit mode={state.prompt} onDismiss={()=>owner.dismissPrompt()} onLogin={()=>auth('/auth/login')} onRegister={()=>auth('/auth/register')} onRetry={()=>{void owner.refresh().then(()=>{owner.check(actor());});}}/>
 </TTScreen>;
}
export default UploadScreen;
