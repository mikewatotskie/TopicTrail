import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
async function review(url:string){
 const tokens=resolve('src/core/design/tokens.ts').replaceAll('\\','/');
 const result=await build({stdin:{contents:`export {ExternalLinkReview} from './src/features/resources/ExternalLinkReview.web';`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.svg':'dataurl'},plugins:[{name:'io',setup(b){b.onResolve({filter:/^react-native$|ThemeContext$|^expo-image$|^@expo\/vector-icons$|^react-native-safe-area-context$/},a=>({path:a.path,namespace:'io'}));b.onLoad({filter:/.*/,namespace:'io'},a=>({contents:a.path==='react-native'?`export * from 'react-native-web';`:a.path==='react-native-safe-area-context'?`export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`:a.path==='expo-image'?`import React from 'react';export const Image=()=>React.createElement('span');`:a.path==='@expo/vector-icons'?`import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`:`import {TTLightColors} from '${tokens}';export const useColors=()=>({colors:TTLightColors});export const useTheme=()=>({colorScheme:'light'});`,loader:'tsx',resolveDir:process.cwd()}));}}]});
 const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(resolve('package.json')),module,module.exports);
 return new JSDOM(renderToStaticMarkup(React.createElement((module.exports as {ExternalLinkReview:React.ComponentType<{url:string;onCancel():void}>}).ExternalLinkReview,{url,onCancel(){}})));
}
test('web reviewed HTTPS anchor uses safe tab attributes and truthful platform limitation',async()=>{
 const dom=await review('https://en.wikipedia.org/wiki/Photosynthesis');try{const a=dom.window.document.querySelector('a')!;assert.ok(a);assert.equal(a.target,'_blank');assert.equal(a.rel,'noopener noreferrer');assert.equal(a.href,'https://en.wikipedia.org/wiki/Photosynthesis');assert.match(dom.window.document.body.textContent!,/cannot enforce|does not enforce/)}finally{dom.window.close()}
});
test('unsafe or unencrypted destinations have no active web anchor',async()=>{
 for(const url of ['javascript:alert(1)','https://127.0.0.1/private','http://example.com']){const dom=await review(url);try{assert.equal(dom.window.document.querySelector('a'),null)}finally{dom.window.close()}}
});
