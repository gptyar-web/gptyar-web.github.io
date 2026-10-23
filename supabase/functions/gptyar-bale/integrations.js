import {assert,AppError} from './domain.js';
import {Bale,Extension} from './clients.js';
import {Rubika} from './rubika.js';
import {random} from './crypto.js';

export async function saveIntegration(ctx,b,actor){
 assert(['bale_bot','bale_payment','extension_admin','rubika_bot'].includes(b.kind)&&typeof b.token==='string','INVALID_INPUT');
 const token=b.token.trim();await ctx.rate('integration:'+actor,20,300);
 return ctx.lease('integrations',async()=>{
  const settings=await ctx.settings();
  const persist=async(meta={},webhook=null)=>ctx.db.rpc('save_integration',{p_kind:b.kind,p_cipher:await ctx.encrypt(token,'secret:'+b.kind),p_webhook:webhook?await ctx.encrypt(webhook,'secret:webhook'):null,p_meta:meta});
  const hasOrders=async()=>!!(await ctx.db.one('orders','select=id&or=(paid_at.not.is.null,status.in.(pending,checkout))'));
  if(b.kind==='rubika_bot'){
   // Token and webhook nonce are stored AES-GCM encrypted, never in Pages.
   assert(token.length>=10&&token.length<=512&&!/\\s/.test(token),'INVALID_RUBIKA_TOKEN');
   const client=new Rubika(token,ctx.transport);
   const me=await client.call('getMe'),bot=me?.bot||me;
   assert(bot&&typeof bot.bot_id==='string'&&bot.bot_id&&typeof bot.username==='string','INVALID_RUBIKA_TOKEN');
   const freshWebhook=random(),url=`${ctx.env.SUPABASE_URL}/functions/v1/gptyar-bale/rubika/webhook/${freshWebhook}`;
   await client.call('updateBotEndpoints',{type:'ReceiveUpdate',url});
   // Save after successful registration, so no invalid config is persisted.
   await ctx.saveSecret('rubika_webhook',freshWebhook);
   await ctx.saveSecret('rubika_bot',token);
   await ctx.audit('integration.rubika_connected',actor,{username:bot.username});
   return{ok:true,username:bot.username,share_url:bot.share_url||null};
  }
  if(b.kind==='bale_bot'){
   assert(/^\d+:[A-Za-z0-9_-]{20,200}$/.test(token),'INVALID_BOT_TOKEN');
   const client=new Bale(token,ctx.transport),me=await client.call('getMe');assert(me?.is_bot&&Number.isSafeInteger(me.id),'INVALID_BOT_TOKEN');
   if(settings.bot_id&&String(settings.bot_id)!==String(me.id))assert(!await hasOrders(),'BOT_ACCOUNT_LOCKED',409);
   const previous=await client.call('getWebhookInfo');
   const sameBot=String(settings.bot_id)===String(me.id),secret=sameBot?await ctx.secret('webhook')||random():random();
   await client.call('setWebhook',{url:`${ctx.env.SUPABASE_URL}/functions/v1/gptyar-bale/webhook/${secret}`});
   try{await persist({bot_id:me.id,username:me.username||''},secret);}
   catch(e){
    try{if(previous?.url)await client.call('setWebhook',{url:previous.url});else await client.call('deleteWebhook');}
    catch{throw new AppError('WEBHOOK_RESTORE_FAILED',502);}
    throw e;
   }
   if(settings.bot_id&&!sameBot){const old=await ctx.secret('bale_bot');if(old)await new Bale(old,ctx.transport).call('deleteWebhook').catch(()=>{});}
   await ctx.audit('integration.bale_connected',actor,{username:me.username});return{ok:true,username:me.username};
  }
  if(b.kind==='bale_payment'){
   assert(token.length>=10&&token.length<=300&&!/\s/.test(token)&&!token.startsWith('WALLET-TEST-'),'INVALID_PAYMENT_TOKEN');
   await persist();await ctx.audit('integration.payment_saved',actor);return{ok:true,verified:false};
  }
  const result=await new Extension(token,settings.extension_version,ctx.transport).validate();
  if(settings.extension_account_id&&settings.extension_account_id!==result.accountId){
   const [subscription,orders]=await Promise.all([ctx.db.one('subscriptions','select=id'),hasOrders()]);
   assert(!subscription&&!orders,'EXTENSION_ACCOUNT_LOCKED',409);
  }
  await persist({account_id:result.accountId});
  await ctx.audit('integration.extension_connected',actor,{account_id:result.accountId});
  return{ok:true,account_id:result.accountId,count:result.count};
 });
}
