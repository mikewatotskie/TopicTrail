import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createAreaController, regionFromCorners, regionViewportRect, type RegionViewport } from '../src/features/reader/reader_regions';
import type { RegionAnchorV1 } from '../src/core/services/annotations/types';

test('region marks use exact unrotated crop coordinates across scale and intrinsic rotation', () => {
  const anchor:RegionAnchorV1={kind:'region',version:1,rect:[30,50,60,90],pageBox:[10,20,110,220]};
  const cases: {view:RegionViewport;rect:[number,number,number,number]}[] = [
    {view:{width:50,height:100,transform:[.5,0,0,-.5,-5,110],pageBox:[10,20,110,220]},rect:[10,65,25,85]},
    {view:{width:200,height:100,transform:[0,1,1,0,-20,-10],pageBox:[10,20,110,220]},rect:[30,20,70,50]},
    {view:{width:300,height:600,transform:[-3,0,0,3,330,-60],pageBox:[10,20,110,220]},rect:[150,90,240,210]},
    {view:{width:400,height:200,transform:[0,-2,-2,0,440,220],pageBox:[10,20,110,220]},rect:[260,100,340,160]},
  ];
  for(const {view,rect} of cases){
    assert.deepEqual(regionViewportRect(view,anchor),rect);
    assert.deepEqual(regionFromCorners(view,[rect[0],rect[1]],[rect[2],rect[3]]),anchor);
  }
  assert.equal(regionFromCorners(cases[0].view,[5,5],[5,8]),null);
  assert.equal(regionViewportRect({...cases[0].view,pageBox:[0,0,100,200]},anchor),null);
});

test('drag, two separate taps and keyboard corners produce the same mark; second touch and Escape cancel', () => {
  const dom=new JSDOM('<main></main>');const surface=dom.window.document.querySelector('main')!;
  surface.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:100,bottom:100,width:100,height:100,toJSON(){return {};}});
  const previews:RegionAnchorV1[]=[];let cancels=0;
  const view:RegionViewport={width:100,height:100,transform:[1,0,0,-1,0,100],pageBox:[0,0,100,100]};
  const controller=createAreaController(surface,view,a=>previews.push(a),()=>cancels++);
  const input=surface.querySelector('.tt-area-input')!;
  const pointer=(type:string,x:number,y:number,id=1,primary=true)=>{const event=new dom.window.MouseEvent(type,{clientX:x,clientY:y,bubbles:true,cancelable:true});Object.defineProperties(event,{pointerId:{value:id},isPrimary:{value:primary}});input.dispatchEvent(event);};
  const key=(value:string)=>input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));
  controller.begin('drag');pointer('pointerdown',50,50);pointer('pointermove',60,60);pointer('pointerup',60,60);
  controller.begin('corners');pointer('pointerdown',50,50);pointer('pointerup',50,50);assert.equal(previews.length,1);pointer('pointerdown',60,60);pointer('pointerup',60,60);
  controller.begin('corners');key('Enter');key('ArrowRight');key('ArrowRight');key('ArrowDown');key('ArrowDown');key('Enter');
  assert.equal(previews.length,3);for(const preview of previews)assert.deepEqual(preview.rect,[50,40,60,50]);
  assert.equal(input.classList.contains('active'),false);
  controller.begin('drag');pointer('pointerdown',10,10);pointer('pointerdown',80,80,2,false);pointer('pointerup',30,30);assert.equal(cancels,1);assert.equal(previews.length,3);
  controller.begin('corners');key('Enter');key('Escape');assert.equal(cancels,2);assert.equal(controller.preview,undefined);
  controller.restore(previews[0]);assert.deepEqual(controller.preview,previews[0]);controller.dispose();assert.equal(surface.children.length,0);
  dom.window.close();
});
