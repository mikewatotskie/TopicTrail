import React,{useEffect,useRef} from 'react';
import {Modal,Platform,ScrollView,Text,View} from 'react-native';
import {TTButton,TTCard} from '../../components';
import {TTTypography} from '../../core/design/tokens';
import {useColors} from '../../core/theme/ThemeContext';
import type {UploadPrompt} from './upload_session';
interface Props {mode:UploadPrompt;onDismiss():void;onLogin():void;onRegister():void;onRetry():void}
export function GuestUploadLimit({mode,onDismiss,onLogin,onRegister,onRetry}:Props) {
 const {colors}=useColors();const ref=useRef<React.ElementRef<typeof View>>(null);const dismiss=useRef(onDismiss);
 useEffect(()=>{dismiss.current=onDismiss},[onDismiss]);
 useEffect(()=>{
   if(!mode||Platform.OS!=='web'||typeof document==='undefined')return;
   const previous=document.activeElement as HTMLElement|null;
   let cleanup=()=>{};
   const setup=()=>{
     const host=ref.current as unknown as HTMLElement|null;if(!host)return;
     const focusable=()=>[...host.querySelectorAll<HTMLElement>('[role="button"]:not([aria-disabled="true"]),button:not([disabled]),[tabindex="0"]')];
     let portal:HTMLElement=host;while(portal.parentElement&&portal.parentElement!==document.body)portal=portal.parentElement;
     const background=[...document.body.children].filter(node=>node!==portal).map(node=>({node:node as HTMLElement,hidden:node.getAttribute('aria-hidden'),inert:(node as HTMLElement).inert}));
     background.forEach(({node})=>{node.inert=true;node.setAttribute('aria-hidden','true')});
     const focus=()=>focusable()[0]?.focus();focus();
     const key=(event:KeyboardEvent)=>{
       if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();dismiss.current();return;}
       if(event.key!=='Tab')return;const nodes=focusable();if(!nodes.length)return;
       const index=nodes.indexOf(document.activeElement as HTMLElement);event.preventDefault();nodes[(index+(event.shiftKey?-1:1)+nodes.length)%nodes.length].focus();
     };
     const contain=(event:FocusEvent)=>{if(event.target instanceof Node&&!host.contains(event.target))focus();};
     document.addEventListener('keydown',key,true);document.addEventListener('focusin',contain,true);
     cleanup=()=>{document.removeEventListener('keydown',key,true);document.removeEventListener('focusin',contain,true);background.forEach(({node,hidden,inert})=>{node.inert=inert;if(hidden===null)node.removeAttribute('aria-hidden');else node.setAttribute('aria-hidden',hidden)});if(previous?.isConnected)previous.focus();};
   };
   // The native web Modal mounts its portal in an effect; run after that commit.
   const timer=setTimeout(setup,0);return()=>{clearTimeout(timer);cleanup();};
 },[mode]);
 if(!mode)return null;
 return <Modal accessibilityLabel={mode==='limit'?'Log in to upload more':'Guest upload allowance unavailable'} visible transparent animationType="none" onRequestClose={onDismiss}>
   <View ref={ref} accessibilityLabel={mode==='limit'?'Log in to upload more':'Guest upload allowance unavailable'} style={{flex:1,backgroundColor:'rgba(11,18,32,0.56)',justifyContent:'center',alignItems:'center',padding:16}}>
    <ScrollView style={{width:'100%',maxWidth:480,flexGrow:0}} contentContainerStyle={{flexGrow:0}}>
     <TTCard padding={24} borderRadius={24} style={{gap:16}}>
      <Text accessibilityRole="header" style={[TTTypography.title,{color:colors.ink}]}>{mode==='limit'?'Log in to upload more':'Guest upload allowance unavailable'}</Text>
      <Text style={[TTTypography.body,{color:colors.muted}]}>{mode==='limit'?"You've used your 2 guest uploads. Log in or create an account to add another syllabus.":'We couldn’t verify your guest upload allowance. Your existing files have not been reset.'}</Text>
      {mode==='unavailable'&&<TTButton label="Retry check" onPress={onRetry}/>}
      <TTButton label="Log in" onPress={onLogin}/>
      {mode==='limit'&&<TTButton label="Create account" variant="secondary" onPress={onRegister}/>}
      <TTButton label="Not now" variant="ghost" onPress={onDismiss}/>
     </TTCard>
    </ScrollView>
   </View>
 </Modal>;
}
