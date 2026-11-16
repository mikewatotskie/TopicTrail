import type { RegionAnchorV1 } from '../../core/services/annotations/types';
import { isRegionAnchor } from './reader_anchors';
export interface RegionViewport { width: number; height: number; transform: readonly number[]; pageBox: [number,number,number,number] }
export type Point = [number,number];
export function pdfPoint(view: RegionViewport, point: Point): Point {
  const [a,b,c,d,e,f] = view.transform; const determinant = a*d-b*c;
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error('Invalid page transform.');
  return [(d*(point[0]-e)-c*(point[1]-f))/determinant,(-b*(point[0]-e)+a*(point[1]-f))/determinant];
}
export function viewportPoint(view: RegionViewport, point: Point): Point {
  const [a,b,c,d,e,f] = view.transform; return [a*point[0]+c*point[1]+e,b*point[0]+d*point[1]+f];
}
export function regionFromCorners(view: RegionViewport, first: Point, second: Point): RegionAnchorV1 | null {
  if ([...first,...second].some(v => !Number.isFinite(v))) return null;
  const clamp = (p: Point): Point => [Math.max(0,Math.min(view.width,p[0])),Math.max(0,Math.min(view.height,p[1]))];
  const a=pdfPoint(view,clamp(first)), b=pdfPoint(view,clamp(second));
  const box=view.pageBox;
  const rect:[number,number,number,number]=[Math.max(box[0],Math.min(a[0],b[0])),Math.max(box[1],Math.min(a[1],b[1])),Math.min(box[2],Math.max(a[0],b[0])),Math.min(box[3],Math.max(a[1],b[1]))];
  const anchor:RegionAnchorV1={kind:'region',version:1,rect,pageBox:[...box]};
  return isRegionAnchor(anchor) ? anchor : null;
}
export function regionViewportRect(view: RegionViewport, anchor: RegionAnchorV1): [number,number,number,number] | null {
  if (!isRegionAnchor(anchor) || anchor.pageBox.some((n,i) => n !== view.pageBox[i])) return null;
  const [x1,y1,x2,y2]=anchor.rect;
  const points=[viewportPoint(view,[x1,y1]),viewportPoint(view,[x2,y1]),viewportPoint(view,[x2,y2]),viewportPoint(view,[x1,y2])];
  return [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
}

/** One explicit gesture mode. Completed previews are data, so zoom/resize can reproject them. */
export function createAreaController(surface:HTMLElement, view:RegionViewport, preview:(anchor:RegionAnchorV1)=>void, cancelled:()=>void) {
  const doc=surface.ownerDocument;
  const layer=doc.createElement('div');layer.className='tt-area-input';layer.tabIndex=-1;layer.setAttribute('role','group');
  layer.setAttribute('aria-label','Mark PDF area. Arrow keys move the crosshair. Enter chooses each corner. Escape cancels.');
  const crosshair=doc.createElement('span');crosshair.className='tt-area-crosshair';crosshair.setAttribute('aria-hidden','true');
  const rectangle=doc.createElement('span');rectangle.className='tt-area-preview';rectangle.setAttribute('aria-hidden','true');
  const status=doc.createElement('span');status.className='tt-annotation-status';status.setAttribute('aria-live','polite');
  layer.append(crosshair,rectangle,status);surface.append(layer);
  let mode:'drag'|'corners'='drag', active=false, first:Point|undefined, pointer:number|undefined, down:Point|undefined;
  let cursor:Point=[view.width/2,view.height/2];let completed:RegionAnchorV1|undefined;
  const position=()=>{crosshair.style.left=cursor[0]+'px';crosshair.style.top=cursor[1]+'px';};
  const draw=(anchor?:RegionAnchorV1)=>{const rect=anchor&&regionViewportRect(view,anchor);rectangle.style.display=rect?'block':'none';if(rect){rectangle.style.left=rect[0]+'px';rectangle.style.top=rect[1]+'px';rectangle.style.width=(rect[2]-rect[0])+'px';rectangle.style.height=(rect[3]-rect[1])+'px';}};
  const disable=()=>{active=false;pointer=undefined;down=undefined;first=undefined;layer.classList.remove('active');layer.tabIndex=-1;};
  const cancel=()=>{disable();completed=undefined;draw();cancelled();};
  const finish=(second:Point)=>{const anchor=first&&regionFromCorners(view,first,second);if(!anchor)return;completed=anchor;disable();draw(anchor);preview(anchor);};
  const point=(event:PointerEvent):Point=>{const rect=surface.getBoundingClientRect();return [Math.max(0,Math.min(view.width,(event.clientX-rect.left)*view.width/rect.width)),Math.max(0,Math.min(view.height,(event.clientY-rect.top)*view.height/rect.height))];};
  layer.addEventListener('pointerdown',event=>{if(!active)return;if(pointer!==undefined || event.isPrimary===false){cancel();return;}event.preventDefault();pointer=event.pointerId;down=point(event);cursor=down;position();if(mode==='drag')first=down;layer.setPointerCapture?.(event.pointerId);});
  layer.addEventListener('pointermove',event=>{if(!active || pointer!==event.pointerId)return;cursor=point(event);position();if(first)draw(regionFromCorners(view,first,cursor)??undefined);});
  layer.addEventListener('pointerup',event=>{if(!active || pointer!==event.pointerId)return;event.preventDefault();const end=point(event);pointer=undefined;
    if(mode==='drag'){if(down&&Math.hypot(end[0]-down[0],end[1]-down[1])>=3)finish(end);else{first=undefined;draw();}}
    else if(down&&Math.hypot(end[0]-down[0],end[1]-down[1])<12){if(first)finish(end);else{first=end;status.textContent='First corner set. Choose the opposite corner.';}}
    down=undefined;});
  layer.addEventListener('pointercancel',()=>{if(active)cancel();});
  const secondPointer=(event:PointerEvent)=>{if(active&&pointer!==undefined&&event.pointerId!==pointer)cancel();};
  doc.addEventListener('pointerdown',secondPointer,true);
  layer.addEventListener('keydown',event=>{if(!active)return;if(event.key==='Escape'){event.preventDefault();cancel();return;}
    if(event.key==='Enter'){event.preventDefault();if(first)finish(cursor);else{first=[...cursor];status.textContent='First corner set. Move to the opposite corner and press Enter.';}return;}
    const step=event.shiftKey?20:5;const movement:Record<string,Point>={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]};
    const delta=movement[event.key];if(!delta)return;event.preventDefault();cursor=[Math.max(0,Math.min(view.width,cursor[0]+delta[0])),Math.max(0,Math.min(view.height,cursor[1]+delta[1]))];position();crosshair.scrollIntoView?.({block:'nearest',inline:'nearest'});if(first)draw(regionFromCorners(view,first,cursor)??undefined);
  });
  return {
    begin(next:'drag'|'corners') {mode=next;completed=undefined;first=undefined;pointer=undefined;cursor=[view.width/2,view.height/2];active=true;layer.classList.add('active');layer.tabIndex=0;position();draw();status.textContent=next==='drag'?'Drag an area, or use arrow keys and Enter.':'Tap the first corner, then the opposite corner, or use arrow keys and Enter.';layer.focus({preventScroll:true});crosshair.scrollIntoView?.({block:'center',inline:'center'});},
    cancel,
    get preview(){return completed;},
    restore(anchor:RegionAnchorV1){completed=anchor;disable();draw(anchor);},
    dispose(){disable();doc.removeEventListener('pointerdown',secondPointer,true);layer.remove();},
  };
}
