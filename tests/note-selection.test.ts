import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingNotes, newNotePayload } from '../src/features/notes/note_selection';
import type { AnnotationListItem, TextAnchorV1 } from '../src/core/services/annotations/types';
const anchor=(start:number,end:number):TextAnchorV1=>({kind:'text',version:1,surface:'pdf-text',textHash:'a'.repeat(64),ranges:[{blockId:'line-2',startUtf16:start,endUtf16:end}],quote:'test',prefix:'',suffix:''});
const row=(id:string,start:number,end:number,page=1):AnnotationListItem=>({id,revision:1,deleted:false,parentDeleted:false,syncStatus:'local',payload:{...newNotePayload(),id,documentId:'doc',documentHash:'b'.repeat(64),format:'pdf',location:{unit:'page',index:page},anchor:anchor(start,end)}});
test('reselecting a part reopens the full existing note; exact anchor takes precedence',()=>{
 const rows=[row('full',0,20),row('other',8,25),row('repeat',5,10,2)];
 assert.deepEqual(matchingNotes(rows,'doc','b'.repeat(64),1,anchor(1,4)).map(x=>x.id),['full']);
 assert.deepEqual(matchingNotes(rows,'doc','b'.repeat(64),1,anchor(9,11)).map(x=>x.id),['full','other']);
 assert.deepEqual(matchingNotes([...rows,row('exact',9,11)],'doc','b'.repeat(64),1,anchor(9,11)).map(x=>x.id),['exact']);
 assert.equal(rows[0].payload.anchor?.kind==='text'&&rows[0].payload.anchor.ranges[0].endUtf16,20);
});
test('different original hashes, surfaces, locations and deleted notes cannot be reused',()=>{
 const rows=[row('note',0,20)];
 assert.equal(matchingNotes(rows,'doc','c'.repeat(64),1,anchor(1,4)).length,0);
 assert.equal(matchingNotes(rows,'doc','b'.repeat(64),3,anchor(1,4)).length,0);
 assert.equal(matchingNotes(rows,'doc','b'.repeat(64),1,{...anchor(1,4),surface:'ocr-text'}).length,0);
 assert.equal(matchingNotes([{...rows[0],deleted:true}],'doc','b'.repeat(64),1,anchor(1,4)).length,0);
});
