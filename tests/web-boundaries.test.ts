import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const entry=`export * as storage from './src/core/services/document_storage';export * as importer from './src/core/services/document_import';export * as content from './src/core/services/document_content';export * as docx from './src/core/services/docx_text_extraction';export * as bookmarks from './src/core/services/bookmarks/storage';`;
test('web storage/import/content/bookmarks resolve web files and never resolve native File IO',async()=>{
 let nativeFileImports=0;
 const result=await build({stdin:{contents:entry,loader:'ts',resolveDir:process.cwd()},bundle:true,write:false,metafile:true,platform:'browser',format:'esm',resolveExtensions:['.web.tsx','.web.ts','.tsx','.ts','.js','.json'],external:['expo-document-picker'],plugins:[{name:'native-io-tripwire',setup(b){b.onResolve({filter:/^expo-file-system$/},()=>{nativeFileImports++;throw Error('Web workflow reached native filesystem')})}}]});
 assert.equal(nativeFileImports,0);const inputs=Object.keys(result.metafile!.inputs);
 for(const name of ['document_storage.web.ts','document_import.web.ts','document_content.web.ts','docx_text_extraction.web.ts','bookmarks/storage.web.ts'])assert.ok(inputs.some(p=>p.endsWith(name)),name);
});
test('default native module resolution retains original File-based adapters',async()=>{
 const result=await build({stdin:{contents:entry,loader:'ts',resolveDir:process.cwd()},bundle:true,write:false,metafile:true,platform:'node',format:'cjs',packages:'external'});
 const inputs=Object.keys(result.metafile!.inputs);
 assert.ok(inputs.some(p=>p.endsWith('services/document_storage.ts')));assert.ok(inputs.some(p=>p.endsWith('bookmarks/storage.ts')));
 assert.equal(inputs.some(p=>p.includes('.web.')),false);
 assert.ok(result.metafile!.outputs['stdin.js'].imports.some(p=>p.path==='expo-file-system'));
});
