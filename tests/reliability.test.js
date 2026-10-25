import test from 'node:test';
import assert from 'node:assert/strict';
import {Database,Extension} from '../supabase/functions/gptyar-bale/clients.js';
import {preCheckout,sendInvoice} from '../supabase/functions/gptyar-bale/bot.js';
import {saveIntegration} from '../supabase/functions/gptyar-bale/integrations.js';
import {AppError} from '../supabase/functions/gptyar-bale/domain.js';

test('versioned order RPC reaches PostgREST and unwraps its actual composite row response',async()=>{
 const paths=[],db=new Database({SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'server-test-key'},async(url,opts)=>{paths.push(new URL(url).pathname);assert.equal(opts.method,'POST');return Response.json([{id:'order',total_toman:0}]);});
 assert.equal((await db.rpc('new_order_v2',{})).id,'order');assert.equal((await db.rpc('checkout_order',{})).total_toman,0);
 assert.deepEqual(paths,['/rest/v1/rpc/gpyb_new_order_v2','/rest/v1/rpc/gpyb_checkout_order']);
 for(const path of ['gpyb_orders/../profiles','rpc/gpyb_complete/extra','gpyb_orders#anything','other/gpyb_orders'])await assert.rejects(()=>db.request(path),{code:'DATABASE_RESOURCE'});
});
test('legacy subscriber corruption does not block a different valid subscriber',async()=>{
 const ext=new Extension('@manager','4.6.5',async()=>Response.json({accountId:'a1',subscribers:[{legacy:true},{subscriptionId:'good',name:'Good User',token:'valid-user-token',expiresAt:'2026-12-01T00:00:00Z'}]}));
 const list=await ext.list();assert.equal(list.count,2);assert.equal(list.subscribers.length,1);assert.equal(list.subscribers[0].remote_id,'good');
});
test('extension preserves actionable enterprise expiry and capacity rejection codes',async()=>{
 for(const [upstream,code]of [['ENTERPRISE_EXPIRY_LIMIT','EXTENSION_EXPIRY_LIMIT'],['ENTERPRISE_USER_LIMIT','EXTENSION_USER_LIMIT']]){
  const ext=new Extension('@manager','4.6.5',async()=>Response.json({error:'rejected',code:upstream},{status:400}));
  await assert.rejects(()=>ext.create('Full Name','2026-12-01T00:00:00Z'),e=>e.code===code&&e.definiteRejection);
 }
});
test('checkout failures are answered to Bale with a negative decision',async()=>{
 let answer;const ctx={bale:async()=>({call:async(method,body)=>{assert.equal(method,'answerPreCheckoutQuery');answer=body;}}),ready:async()=>true,db:{rpc:async()=>{throw new AppError('DATABASE_UNREACHABLE',503);}}};
 await preCheckout(ctx,{id:'charge',from:{id:123},total_amount:350000,currency:'IRR',invoice_payload:'11111111-1111-4111-8111-111111111111'});assert.equal(answer.ok,false);assert.ok(answer.error_message);
});
test('an invoice already sent to Bale stays payable if saving its message ID fails',async()=>{
 const order={id:'order1',bale_id:123,status:'pending',days:7,total_toman:245000,expires_at:new Date(Date.now()+1800000).toISOString()},payloads=[];let fail=true;
 const ctx={secret:async()=> 'provider-token',db:{upsert:async()=>{},patch:async(t,q,body)=>{if(body.invoice_message_id&&fail){fail=false;throw new AppError('DATABASE_UNREACHABLE',503);}Object.assign(order,body);return[order];}}};
 const bale={send:async()=>{},call:async(method,body)=>{payloads.push(body.payload);return{message_id:2};}};
 await assert.rejects(()=>sendInvoice(ctx,bale,123,order),{code:'DATABASE_UNREACHABLE'});assert.equal(order.status,'pending');
 await sendInvoice(ctx,bale,123,order);assert.deepEqual(payloads,['order1','order1']);assert.equal(order.error_code,null);
});
function integrationFixture({fail=false}={}){
 const calls=[],saved=[],settings={bot_id:123,extension_version:'4.6.5'};
 const ctx={env:{SUPABASE_URL:'https://db.invalid'},settings:async()=>settings,rate:async()=>{},lease:async(k,f)=>f(),secret:async()=> 'f'.repeat(64),encrypt:async(v,p)=>'encrypted:'+p,
 transport:async(url,opts)=>{const method=url.split('/').at(-1);calls.push({method,body:JSON.parse(opts.body)});return Response.json({ok:true,result:method==='getMe'?{id:123,is_bot:true,username:'test_bot'}:method==='getWebhookInfo'?{url:'https://old.invalid/webhook'}:true});},
 db:{one:async()=>null,rpc:async(name,args)=>{saved.push({name,args});if(fail)throw new AppError('DATABASE_UNREACHABLE',503);return true;}},audit:async()=>{}};
 return{ctx,calls,saved,settings};
}
test('integration failure restores the previous webhook and does not split secret/settings writes',async()=>{
 const f=integrationFixture({fail:true});await assert.rejects(()=>saveIntegration(f.ctx,{kind:'bale_bot',token:'123:'+'t'.repeat(24)},'admin'),{code:'DATABASE_UNREACHABLE'});
 assert.equal(f.saved.length,1);assert.equal(f.saved[0].name,'save_integration');assert.equal(f.saved[0].args.p_cipher,'encrypted:secret:bale_bot');
 assert.equal(f.calls.at(-1).method,'setWebhook');assert.equal(f.calls.at(-1).body.url,'https://old.invalid/webhook');
});
test('reconnecting the same bot preserves its current webhook secret',async()=>{
 const f=integrationFixture();await saveIntegration(f.ctx,{kind:'bale_bot',token:'123:'+'t'.repeat(24)},'admin');
 assert.ok(f.calls.find(c=>c.method==='setWebhook').body.url.endsWith('/'+'f'.repeat(64)));
});
test('rotating the Bale token persists the replacement for the same bot without changing webhook',async()=>{
 const f=integrationFixture(),token='123:'+'n'.repeat(24);
 const result=await saveIntegration(f.ctx,{kind:'bale_bot',token},'admin');
 assert.equal(result.rotated,true);assert.equal(result.username,'test_bot');
 assert.deepEqual(f.saved[0].args.p_meta,{bot_id:123,username:'test_bot'});
 assert.equal(f.saved[0].args.p_cipher,'encrypted:secret:bale_bot');
 assert.equal(f.calls.find(c=>c.method==='setWebhook').body.url,'https://db.invalid/functions/v1/gptyar-bale/webhook/'+'f'.repeat(64));
});
test('unsupported integrations are rejected before any token is saved',async()=>{
 const f=integrationFixture();await assert.rejects(()=>saveIntegration(f.ctx,{kind:'unsupported',token:'unused'},'admin'),{code:'INVALID_INPUT'});
 assert.equal(f.saved.length,0);
});
