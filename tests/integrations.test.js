import test from 'node:test';
import assert from 'node:assert/strict';
import {saveIntegration} from '../supabase/functions/gptyar-bale/integrations.js';
import {adminRoute} from '../supabase/functions/gptyar-bale/admin.js';
import {createHandler} from '../supabase/functions/gptyar-bale/index.js';
import {AppError} from '../supabase/functions/gptyar-bale/domain.js';

function fixture({botId=456,failSave=false,invalidBot=false}={}){
 const calls=[],saved=[],audits=[],oldToken='123:'+'o'.repeat(24),newToken=botId+':'+'n'.repeat(24);
 const settings={bot_id:123,extension_account_id:'old-account',extension_version:'4.6.5'};
 const secrets={bale_bot:oldToken,webhook:'a'.repeat(64)};
 const ctx={env:{SUPABASE_URL:'https://db.invalid'},settings:async()=>settings,rate:async()=>{},lease:async(k,fn)=>fn(),
  secret:async key=>secrets[key],encrypt:async(value,purpose)=>'encrypted:'+purpose+':'+value,
  audit:async(...args)=>audits.push(args),
  transport:async(url,options)=>{
   const method=url.split('/').at(-1);calls.push({url,method,body:options.body?JSON.parse(options.body):null});
   if(url.includes('/accupdator/'))return Response.json(method==='validate'?{account:{id:'new-account'}}:{accountId:'new-account',subscribers:[]});
   return Response.json({ok:true,result:method==='getMe'?{id:botId,is_bot:!invalidBot,username:'new_bot'}:method==='getWebhookInfo'?{url:'https://previous.invalid/webhook'}:true});
  },
  db:{one:async()=>{throw new Error('Replacing credentials must not depend on order counts');},rpc:async(name,args)=>{
   saved.push({name,args});if(failSave)throw new AppError('DATABASE_UNREACHABLE',503);
   // A read after saving would return the NEW token, reproducing the previous cleanup bug.
   if(args.p_kind==='bale_bot')secrets.bale_bot=newToken;
   return true;
  }}
 };
 return{ctx,calls,saved,audits,settings,oldToken,newToken};
}

test('a different Bale bot can replace the connection and only the OLD bot webhook is removed',async()=>{
 const f=fixture(),r=await saveIntegration(f.ctx,{kind:'bale_bot',token:' '+f.newToken+' '},'admin');
 assert.equal(r.wallet_reset,true);assert.equal(f.saved[0].args.p_meta.bot_id,456);
 const configured=f.calls.find(x=>x.method==='setWebhook');
 assert.match(configured.body.url,/\/webhook\/[a-f0-9]{64}$/);
 const removed=f.calls.filter(x=>x.method==='deleteWebhook');assert.equal(removed.length,1);
 assert.ok(removed[0].url.includes('/bot'+f.oldToken+'/'));
 assert.ok(!removed[0].url.includes(f.newToken));
 assert.ok(f.audits.every(x=>!JSON.stringify(x).includes(f.newToken)));
});
test('rotating a token for the same bot preserves its webhook and wallet',async()=>{
 const f=fixture({botId:123}),r=await saveIntegration(f.ctx,{kind:'bale_bot',token:f.newToken},'admin');
 assert.equal(r.wallet_reset,false);assert.ok(f.calls.find(x=>x.method==='setWebhook').body.url.endsWith('/'+'a'.repeat(64)));
 assert.equal(f.calls.some(x=>x.method==='deleteWebhook'),false);
});
test('a failed bot replacement restores the new bot previous webhook and leaves the old bot untouched',async()=>{
 const f=fixture({failSave:true});await assert.rejects(()=>saveIntegration(f.ctx,{kind:'bale_bot',token:f.newToken},'admin'),{code:'DATABASE_UNREACHABLE'});
 assert.equal(f.calls.at(-1).method,'setWebhook');assert.equal(f.calls.at(-1).body.url,'https://previous.invalid/webhook');
 assert.equal(f.calls.some(x=>x.url.includes(f.oldToken)),false);
});
test('wallet token replacement is encrypted without claiming a live payment verification',async()=>{
 const f=fixture(),r=await saveIntegration(f.ctx,{kind:'bale_payment',token:' wallet-provider-new-token '},'admin');
 assert.equal(r.verified,false);assert.equal(f.calls.length,0);assert.equal(f.saved.length,1);
 assert.equal(f.saved[0].args.p_cipher,'encrypted:secret:bale_payment:wallet-provider-new-token');
});
test('a new extension account is validated and saved even with existing subscriptions',async()=>{
 const f=fixture(),r=await saveIntegration(f.ctx,{kind:'extension_admin',token:'@new-manager-token'},'admin');
 assert.equal(r.account_id,'new-account');assert.equal(r.account_changed,true);
 assert.deepEqual(f.saved[0].args.p_meta,{account_id:'new-account'});
 assert.deepEqual(f.calls.map(x=>x.method),['validate','all']);
});
test('invalid credentials and removed integration kinds cannot replace a stored token',async()=>{
 for(const [kind,token,code]of [['rubika_bot','removed-token','INVALID_INPUT'],['bale_bot','bad','INVALID_BOT_TOKEN'],['bale_payment','WALLET-TEST-invalid','INVALID_PAYMENT_TOKEN'],['extension_admin','not-admin','INVALID_ADMIN_TOKEN']]){
  const f=fixture();await assert.rejects(()=>saveIntegration(f.ctx,{kind,token},'admin'),{code});assert.equal(f.saved.length,0);
 }
 const f=fixture({invalidBot:true});await assert.rejects(()=>saveIntegration(f.ctx,{kind:'bale_bot',token:f.newToken},'admin'),{code:'INVALID_BOT_TOKEN'});assert.equal(f.saved.length,0);
});
test('settings expose only the three supported integration statuses',async()=>{
 const keys=['bale_bot','bale_payment','extension_admin','webhook','rubika_bot','rubika_webhook'];
 const ctx={settings:async()=>({}),db:{list:async table=>table==='secrets'?keys.map(key=>({key,updated_at:'now'})):[]}};
 const r=await adminRoute(ctx,'/settings',new Request('https://api.invalid/settings'),{},{admin:{username:'admin'}});
 assert.deepEqual(r.integrations.map(x=>x.key),keys.slice(0,3));
});
test('removed messaging webhooks do not access stored credentials or process events',async()=>{
 let requests=0;const handler=createHandler({SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'server-only-test'},async()=>{requests++;throw new Error('Unexpected network request');});
 const r=await handler(new Request('https://api.invalid/functions/v1/gptyar-bale/rubika/webhook/'+'f'.repeat(64),{method:'POST',body:'{}'}));
 assert.equal(r.status,401);assert.equal(requests,0);
});
