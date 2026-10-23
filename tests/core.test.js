import test from 'node:test';
import assert from 'node:assert/strict';
import {base32,decode32,totp,totpCounter,passwordHash,passwordVerify,cipherKey,seal,open} from '../supabase/functions/gptyar-bale/crypto.js';
import {integer,expiry,verifyPayment,AppError} from '../supabase/functions/gptyar-bale/domain.js';
import {Database,Extension,Bale} from '../supabase/functions/gptyar-bale/clients.js';
import {routePath,createHandler,bodyJSON} from '../supabase/functions/gptyar-bale/index.js';

test('Persian and Arabic numerals are accepted, invalid durations are rejected',()=>{
 assert.equal(integer(' ۳۶۵ '),365);assert.equal(integer('٢١'),21);
 for(const v of ['0','-1','1.2','1e2','3651','۱روز'])assert.throws(()=>integer(v));
});
test('renewal preserves remaining time and expired plans begin now',()=>{
 const now=Date.parse('2026-10-23T00:00:00Z');
 assert.equal(expiry('2026-10-25T00:00:00Z',2,now),'2026-10-27T00:00:00.000Z');
 assert.equal(expiry('2026-10-20T00:00:00Z',2,now),'2026-10-25T00:00:00.000Z');
});
test('TOTP uses RFC 6238 SHA1 vectors and supports Ente six-digit codes',async()=>{
 const bytes=new TextEncoder().encode('12345678901234567890'),secret=base32(bytes);
 assert.deepEqual(decode32(secret),bytes);assert.equal(await totp(secret,1),'287082');
 assert.equal(await totp(secret,Math.floor(1111111109/30)),'081804');
 assert.equal(await totpCounter(secret,'287082',59000),1);
 assert.equal(await totpCounter(secret,'000000',59000),null);
});
test('passwords are salted and wrong passwords fail',async()=>{
 const stored=await passwordHash('a strong test password');
 assert.equal(await passwordVerify('a strong test password',stored),true);
 assert.equal(await passwordVerify('wrong password',stored),false);
 assert.notEqual(await passwordHash('a strong test password'),stored);
});
test('AES-GCM binds secrets to purpose and detects tampering',async()=>{
 const key=await cipherKey({SUPABASE_SERVICE_ROLE_KEY:'test-only-key'});
 const s=await seal('private token','subscriber',key);
 assert.equal(await open(s,'subscriber',key),'private token');
 await assert.rejects(()=>open(s,'totp',key));
 await assert.rejects(()=>open(s.slice(0,-2)+(s.endsWith('00')?'01':'00'),'subscriber',key));
});
test('payment verification rejects wrong payer, amount, currency and unconfirmed transactions',()=>{
 const order={bale_id:123,total_toman:245000,pre_checkout_id:'charge1'},p={currency:'IRR',total_amount:2450000,telegram_payment_charge_id:'charge1'},tx={id:'charge1',status:'paid',userID:123,amount:2450000};
 assert.doesNotThrow(()=>verifyPayment(order,p,tx,123));
 for(const invalid of [{...p,currency:'USD'},{...p,total_amount:245000},{...p,telegram_payment_charge_id:'charge2'}])assert.throws(()=>verifyPayment(order,invalid,tx,123));
 assert.throws(()=>verifyPayment(order,p,tx,124));assert.throws(()=>verifyPayment(order,p,{...tx,status:'pending'},123));
});
test('database adapter refuses resources outside its isolated prefix',async()=>{
 const db=new Database({});await assert.rejects(()=>db.request('profiles'),{code:'DATABASE_RESOURCE'});
});
test('extension adapter requires management capability and consistent account scope',async()=>{
 const token='@management-test-token',calls=[];
 const transport=async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/validate')?{message:'ok',account:{id:'a1'},agent:true}:{accountId:'a1',subscribers:[{subscriptionId:'s1',token:'user-token',expiresAt:'2026-12-01T00:00:00Z'}]});};
 const client=new Extension(token,'4.6.5',transport);assert.equal((await client.validate()).accountId,'a1');assert.equal(calls[1].options.method,'GET');
 assert.equal(calls[0].options.headers.Authorization,'Bearer '+token);
 await assert.rejects(()=>new Extension('not-admin').validate(),{code:'INVALID_ADMIN_TOKEN'});
});
test('Bale invoice requests keep the provider token server-side and send integer rials',async()=>{
 let body;const b=new Bale('123:test',async(url,options)=>{body=JSON.parse(options.body);assert.match(url,/tapi\.bale\.ai/);return Response.json({ok:true,result:{message_id:1}});});
 await b.call('sendInvoice',{chat_id:123,provider_token:'private-wallet',payload:'order',prices:[{label:'7 days',amount:2450000}]});assert.equal(body.prices[0].amount,2450000);
});
test('edge route prefixes work behind Supabase and in local tests',async()=>{
 for(const input of ['/health','/gptyar-bale/health','/functions/v1/gptyar-bale/health']){assert.equal(routePath(input),'/health');const r=await createHandler({})(new Request('https://test.invalid'+input));assert.equal(r.status,200);}
 assert.equal(routePath('/gptyar-bale/auth/login/'),'/auth/login');
 const r=await createHandler({})(new Request('https://test.invalid/health',{headers:{Origin:'https://evil.invalid'}}));assert.equal(r.status,403);
});
test('request bodies are bounded while streaming and malformed JSON is rejected',async()=>{
 assert.deepEqual(await bodyJSON(new Request('https://test.invalid',{method:'POST',body:'{"ok":true}'})),{ok:true});
 await assert.rejects(()=>bodyJSON(new Request('https://test.invalid',{method:'POST',body:'['})),{code:'INVALID_JSON'});
 await assert.rejects(()=>bodyJSON(new Request('https://test.invalid',{method:'POST',body:'x'.repeat(66000)})),{code:'BODY_TOO_LARGE'});
});
