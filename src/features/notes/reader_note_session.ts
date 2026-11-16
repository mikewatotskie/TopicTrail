import type { TextAnchorV1 } from '../../core/services/annotations/types';
import type { ReaderMessage } from '../reader/selection';

/** Captured selection is independent from browser focus and React render timing. */
export class ReaderNoteSession {
  private selection:TextAnchorV1|null=null;
  private pressed:TextAnchorV1|null=null;
  private readyPage:number|null=null;
  private pending:{id:string;open:boolean;requestedPage?:number}|null=null;
  receive(message:ReaderMessage) {
    if(message.type==='render-start'||message.type==='surface-change'||message.type==='selection-reset'||message.type==='selection-limit'||message.type==='error')this.clear();
    if(message.type==='render-start'||message.type==='error')this.readyPage=null;
    if(message.type==='page'){this.readyPage=message.page;this.clear();}
    if(message.type==='selection'&&message.page===this.readyPage&&message.text){this.selection=message.anchor??null;this.pressed=null;}
  }
  clear(){this.selection=null;this.pressed=null;}
  beginNavigation(){this.readyPage=null;this.clear();}
  capture(){this.pressed=this.selection;}
  consume(){const result=this.pressed??this.selection;this.pressed=null;return result;}
  get anchor(){return this.selection;}
  get page(){return this.readyPage;}
  requestReveal(id:string,open=false){this.pending={id,open};}
  get target(){return this.pending?.id;}
  cancelReveal(){this.pending=null;}
  advance(targetPage:number|null,totalPages:number):{type:'wait'}|{type:'navigate';page:number}|{type:'reveal';id:string;open:boolean}|{type:'unavailable'} {
    if(!this.pending||this.readyPage===null)return {type:'wait'};
    if(targetPage!==null&&(targetPage<1||targetPage>totalPages)){this.pending=null;return {type:'unavailable'};}
    if(targetPage!==null&&targetPage!==this.readyPage){
      if(this.pending.requestedPage===targetPage)return {type:'wait'};
      this.pending.requestedPage=targetPage;return {type:'navigate',page:targetPage};
    }
    const {id,open}=this.pending;this.pending=null;return {type:'reveal',id,open};
  }
}
