import {Rubika,normalizeRubikaUpdate} from './rubika.js';
import {assert} from './domain.js';

// The legacy commerce engine stores bigint customers. Rubika users get a
// stable negative integer; Bale users are always positive and never overlap.
export async function rubikaView(ctx){
 const token=await ctx.secret('rubika_bot');
 assert(token,'RUBIKA_NOT_CONFIGURED',409);
 const client=new Rubika(token,ctx.transport);
 const sender=async(virtualId,text,keypad)=>{
  assert(Number.isSafeInteger(Number(virtualId))&&Number(virtualId)<0,'RUBIKA_IDENTITY',409);
  const row=await ctx.db.one('rubika_users',`virtual_id=eq.${virtualId}&select=rubika_id`);
  assert(row?.rubika_id,'RUBIKA_IDENTITY',409);
  return client.send(row.rubika_id,text,keypad);
 };
 return {...ctx,platform:'rubika',bale:async()=>({send:sender}),
  ready:async()=>!!((await ctx.ready())&&token)};
}

// A verified endpoint secret is REQUIRED before calling this method.
// Errors remain retriable, while successful updates are never processed twice.
export async function receiveRubika(ctx,body,handleMessage){
 const event=normalizeRubikaUpdate(body);
 if(!event)return{ok:true,ignored:true};
 const virtualId=Number(await ctx.db.rpc('rubika_identity',{p_user:event.userId}));
 assert(Number.isSafeInteger(virtualId)&&virtualId<0,'RUBIKA_IDENTITY',500);
 const owner=crypto.randomUUID();
 const claimed=await ctx.db.rpc('rubika_claim_update',{p_event:event.eventId,p_owner:owner});
 if(!claimed)return{ok:true,duplicate:true};
 try{
  await ctx.lease(`rubika:chat:${event.userId}`,async()=>{
   const view=await rubikaView(ctx);
   view.requestKey=event.eventId;
   await handleMessage(view,{
    message_id:event.messageId,
    text:event.text,
    from:{id:virtualId},
    chat:{id:virtualId,type:'private'}
   });
  });
  await ctx.db.patch('rubika_updates',
   `event_id=eq.${encodeURIComponent(event.eventId)}&owner=eq.${owner}`,{status:'done'});
  return {ok:true};
 }catch(e){
  await ctx.db.patch('rubika_updates',
   `event_id=eq.${encodeURIComponent(event.eventId)}&owner=eq.${owner}`,{status:'error'}).catch(()=>{});
  throw e;
 }
}
