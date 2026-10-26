import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../supabase/functions/gptyar-bale/index.js';
import {cipherKey,seal} from '../supabase/functions/gptyar-bale/crypto.js';
import {fulfill,checkAvailability} from '../supabase/functions/gptyar-bale/fulfillment.js';
import {sendInvoice,reconcilePayment} from '../supabase/functions/gptyar-bale/bot.js';

test('historical extension records cannot mutate a newly connected account',async()=>{
 let calls=0;
 const ctx={lease:async(k,fn)=>fn(),settings:async()=>({extension_account_id:'new-account'}),
  extension:async()=>({list:async()=>{calls++;return{accountId:'new-account',subscribers:[{remote_id:'shared-id',token:'new-token'}]};}}),
  db:{one:async table=>table==='orders'?{id:'old-order',paid_at:'2026-10-23',status:'paid',extension_account_id:'old-account'}:{remote_id:'shared-id',extension_account_id:'old-account'}}};
 await assert.rejects(()=>fulfill(ctx,'old-order'),{code:'EXTENSION_SCOPE'});assert.equal(calls,0);
 await assert.rejects(()=>checkAvailability(ctx,{subscription_id:'old-subscription',days:7}),{code:'EXTENSION_SCOPE'});
});
test('old invoices cannot be reissued or queried under a different bot credential',async()=>{
 const ctx={settings:async()=>({bot_id:456,extension_account_id:'new-account'})};
 const order={id:'old-order',bot_id:123,extension_account_id:'old-account',pre_checkout_id:'charge',status:'pending',expires_at:new Date(Date.now()+60000).toISOString()};
 await assert.rejects(()=>sendInvoice(ctx,{},101,order),{code:'BOT_SCOPE'});
 await assert.rejects(()=>reconcilePayment(ctx,order),{code:'BOT_SCOPE'});
});
test('webhook deduplication follows the current bot and rejects retired webhook URLs',async()=>{
 const env={SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-server-key'},key=await cipherKey(env);
 let botId=123,hook='a'.repeat(64),deliveries=0;const updates=new Set(),queries=[];
 const transport=async(url,opts)=>{
  const u=new URL(url),path=u.pathname,body=opts.body?JSON.parse(opts.body):null;
  if(u.hostname==='tapi.bale.ai'){deliveries++;return Response.json({ok:true,result:{message_id:1}});}
  if(path.endsWith('/gpyb_secrets')){const name=u.searchParams.get('key').slice(3);return Response.json([{ciphertext:await seal(name==='webhook'?hook:'123:'+'t'.repeat(24),'secret:'+name,key)}]);}
  if(path.endsWith('/gpyb_settings'))return Response.json([{bot_id:botId}]);
  if(path.endsWith('/gpyb_claim_bot_update')){assert.equal(body.p_bot,botId);const id=body.p_bot+':'+body.p_id;if(updates.has(id))return Response.json(false);updates.add(id);return Response.json(true);}
  if(path.endsWith('/gpyb_updates')){queries.push(u.search);return Response.json([{status:'done'}]);}
  if(path.endsWith('/gpyb_lease'))return Response.json(true);
  if(path.endsWith('/gpyb_rate'))return Response.json(1);
  return Response.json([]);
 };
 const handler=createHandler(env,transport),request=secret=>new Request('https://db.invalid/functions/v1/gptyar-bale/webhook/'+secret,{method:'POST',body:JSON.stringify({update_id:7,message:{message_id:1,text:'/start',from:{id:101},chat:{id:101,type:'private'}}})});
 assert.equal((await handler(request(hook))).status,200);
 assert.equal((await (await handler(request(hook))).json()).duplicate,true);assert.equal(deliveries,1);
 const retired=hook;botId=456;hook='b'.repeat(64);
 assert.equal((await handler(request(retired))).status,403);
 assert.equal((await handler(request(hook))).status,200);assert.equal(deliveries,2);
 assert.ok(queries.some(q=>q.includes('bot_id=eq.123'))&&queries.some(q=>q.includes('bot_id=eq.456')));
});
