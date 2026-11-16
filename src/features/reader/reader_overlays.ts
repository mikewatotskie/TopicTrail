import type { ReaderAnnotation } from './reader_protocol';
import { canonicalSurface, resolveTextAnchor, type TextSurface } from './reader_anchors';
import { regionViewportRect, type RegionViewport } from './reader_regions';
import type { AnnotationPlacement } from './selection';

export function installAnnotationStyles(doc:Document) {
  if(doc.getElementById('tt-annotation-styles'))return;
  const style=doc.createElement('style');style.id='tt-annotation-styles';style.textContent=`
  .tt-pdf-surface{position:relative;flex:none;overflow:hidden;background:#fff}
  .tt-annotation-layer{position:absolute;inset:0;pointer-events:none!important;z-index:3;overflow:visible}
  .tt-highlight{position:absolute;pointer-events:none!important;border-bottom:2px solid #6b5400;box-sizing:border-box;mix-blend-mode:multiply}
  .tt-highlight[data-color=yellow]{background:rgba(255,213,68,.35);border-color:#816000}
  .tt-highlight[data-color=green]{background:rgba(88,204,132,.30);border-color:#136b39}
  .tt-highlight[data-color=blue]{background:rgba(100,170,255,.30);border-color:#215c9e}
  .tt-highlight[data-color=purple]{background:rgba(187,136,245,.30);border-color:#75439f}
  .tt-note-indicator{position:absolute;right:-7px;top:-7px;background:#fff;color:#1d3557;border:1px solid #1d3557;border-radius:3px;font:700 11px/14px sans-serif;min-width:14px;text-align:center;mix-blend-mode:normal}
  .tt-highlight.tt-revealed{outline:3px solid #1559a8;outline-offset:2px}
  [data-theme=dark] .tt-highlight{mix-blend-mode:screen}
  [data-theme=dark] .tt-pdf-surface .tt-highlight{mix-blend-mode:multiply}
  .tt-area-input{position:absolute;inset:0;z-index:5;pointer-events:none;touch-action:auto}
  .tt-area-input.active{pointer-events:auto;touch-action:none;cursor:crosshair;outline:3px solid #1559a8;outline-offset:2px}
  .tt-area-crosshair{display:none;position:absolute;width:20px;height:20px;transform:translate(-50%,-50%);border:2px solid #073b74;border-radius:50%;background:rgba(255,255,255,.6);pointer-events:none}
  .tt-area-input.active .tt-area-crosshair{display:block}.tt-area-crosshair:after{content:'+';position:absolute;inset:-6px;color:#073b74;font:bold 24px/28px sans-serif;text-align:center}
  .tt-area-preview{display:none;position:absolute;border:3px dashed #1559a8;background:rgba(67,145,234,.20);box-sizing:border-box;pointer-events:none}
  .tt-annotation-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
  `;doc.head.append(style);
}

export function drawAnnotations(root:HTMLElement, items:ReaderAnnotation[], pdfSurface?:HTMLElement, viewport?:RegionViewport): AnnotationPlacement[] {
  root.querySelectorAll('.tt-annotation-layer').forEach(layer=>layer.remove());
  const modelCache=new Map<TextSurface,ReturnType<typeof canonicalSurface>>();
  const layerCache=new Map<HTMLElement,HTMLElement>();
  const layerFor=(container:HTMLElement)=>{let layer=layerCache.get(container);if(!layer){layer=root.ownerDocument.createElement('div');layer.className='tt-annotation-layer';layer.setAttribute('aria-label','Saved highlights');container.append(layer);layerCache.set(container,layer);}return layer;};
  const rectangle=(container:HTMLElement,rect:[number,number,number,number],item:ReaderAnnotation,first:boolean)=>{
    const node=root.ownerDocument.createElement('span');node.className='tt-highlight';node.dataset.annotationId=item.id;node.dataset.color=item.color;
    node.setAttribute('role','img');node.setAttribute('aria-label',`${item.color} highlight${item.hasNote?' with note':''}`);
    node.style.left=rect[0]+'px';node.style.top=rect[1]+'px';node.style.width=(rect[2]-rect[0])+'px';node.style.height=(rect[3]-rect[1])+'px';
    if(first&&item.hasNote){const indicator=root.ownerDocument.createElement('span');indicator.className='tt-note-indicator';indicator.textContent='N';indicator.setAttribute('aria-hidden','true');node.append(indicator);}layerFor(container).append(node);
  };
  return items.map(item=>{
    if(item.anchor.kind==='region'){
      const rect=viewport&&regionViewportRect(viewport,item.anchor);if(!pdfSurface||!rect)return {id:item.id,status:'needs-review'};
      rectangle(pdfSurface,rect,item,true);return {id:item.id,status:'placed'};
    }
    let model=modelCache.get(item.anchor.surface);if(!model){model=canonicalSurface(root,item.anchor.surface);modelCache.set(item.anchor.surface,model);}
    if(item.anchor.surface==='ocr-text'&&!model.blocks.length)return {id:item.id,status:'recognize-page'};
    const ranges=resolveTextAnchor(model,item.anchor);if(!ranges)return {id:item.id,status:'needs-review'};
    const container=item.anchor.surface==='pdf-text'&&pdfSurface?pdfSurface:root;
    const bounds=container.getBoundingClientRect();let first=true;
    for(const range of ranges){for(const rect of Array.from(range.getClientRects?.()??[])){if(rect.width<=0||rect.height<=0)continue;rectangle(container,[rect.left-bounds.left+container.scrollLeft-container.clientLeft,rect.top-bounds.top+container.scrollTop-container.clientTop,rect.right-bounds.left+container.scrollLeft-container.clientLeft,rect.bottom-bounds.top+container.scrollTop-container.clientTop],item,first);first=false;}}
    return {id:item.id,status:'placed'};
  });
}

export function revealAnnotation(root:HTMLElement, item:ReaderAnnotation):boolean {
  if(item.anchor.kind==='text'){
    const model=canonicalSurface(root,item.anchor.surface);const ranges=resolveTextAnchor(model,item.anchor);if(!ranges)return false;
    let node:Element|null=ranges[0].startContainer.parentElement;
    while(node&&node!==root){if(node.tagName==='DETAILS')(node as HTMLDetailsElement).open=true;node=node.parentElement;}
    ranges[0].startContainer.parentElement?.scrollIntoView?.({block:'center'});
  }
  const nodes=[...root.querySelectorAll<HTMLElement>('[data-annotation-id]')].filter(node=>node.dataset.annotationId===item.id);
  nodes.forEach(node=>node.classList.add('tt-revealed'));nodes[0]?.scrollIntoView?.({block:'center'});return item.anchor.kind==='text'||nodes.length>0;
}
