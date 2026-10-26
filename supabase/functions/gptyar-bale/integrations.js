import {assert,AppError} from './domain.js';
import {Bale,Extension} from './clients.js';
import {random} from './crypto.js';

export const INTEGRATION_KINDS=['bale_bot','bale_payment','extension_admin'];

export async function saveIntegration(ctx,b,actor){
 assert(INTEGRATION_KINDS.includes(b.kind)&&typeof b.token==='string','INVALID_INPUT');
 const token=b.token.trim();await ctx.rate('integration:'+actor,20,300);
 return ctx.lease('integrations',async()=>{
  const settings=await ctx.settings();
  const persist=async(meta={},webhook=null)=>ctx.db.rpc('save_integration',{p_kind:b.kind,p_cipher:await ctx.encrypt(token,'secret:'+b.kind),p_webhook:webhook?await ctx.encrypt(webhook,'secret:webhook'):null,p_meta:meta});
  if(b.kind==='bale_bot'){
   assert(/^\d+:[A-Za-z0-9_-]{20,200}$/.test(token),'INVALID_BOT_TOKEN');
   const client=new Bale(token,ctx.transport),me=await client.call('getMe');assert(me?.is_bot&&Number.isSafeInteger(me.id),'INVALID_BOT_TOKEN');
   const previous=await client.call('getWebhookInfo');
   const sameBot=String(settings.bot_id)===String(me.id),walletReset=!!settings.bot_id&&!sameBot;
   // Read the old credential before persistence; afterwards the database contains the new bot's token.
   const oldToken=walletReset?await ctx.secret('bale_bot'):null;
   const secret=sameBot?await ctx.secret('webhook')||random():random();
   await client.call('setWebhook',{url:`${ctx.env.SUPABASE_URL}/functions/v1/gptyar-bale/webhook/${secret}`});
   try{await persist({bot_id:me.id,username:me.username||''},secret);}
   catch(e){
    try{if(previous?.url)await client.call('setWebhook',{url:previous.url});else await client.call('deleteWebhook');}
    catch{throw new AppError('WEBHOOK_RESTORE_FAILED',502);}
    throw e;
   }
   if(oldToken&&oldToken!==token)await new Bale(oldToken,ctx.transport).call('deleteWebhook').catch(()=>{});
   await ctx.audit('integration.bale_connected',actor,{username:me.username});return{ok:true,username:me.username,wallet_reset:walletReset};
  }
  if(b.kind==='bale_payment'){
   assert(token.length>=10&&token.length<=300&&!/\s/.test(token)&&!token.startsWith('WALLET-TEST-'),'INVALID_PAYMENT_TOKEN');
   await persist();await ctx.audit('integration.payment_saved',actor);return{ok:true,verified:false};
  }
  const result=await new Extension(token,settings.extension_version,ctx.transport).validate();
  await persist({account_id:result.accountId});
  await ctx.audit('integration.extension_connected',actor,{account_id:result.accountId});
  return{ok:true,account_id:result.accountId,count:result.count,account_changed:!!settings.extension_account_id&&settings.extension_account_id!==result.accountId};
 });
}
