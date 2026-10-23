import test from 'node:test';
import assert from 'node:assert/strict';
import {Extension} from '../supabase/functions/gptyar-bale/clients.js';
import {attachToken} from '../supabase/functions/gptyar-bale/fulfillment.js';

const adminToken='@managed-token-123';
const endpoint='https://api.gptyar.com/accupdator/';
function mockApi({accountId='account-1',otherId=accountId,agent}={}){
 const calls=[];
 const transport=async(url,init)=>{
  calls.push({url,method:init.method,headers:init.headers,body:init.body?JSON.parse(init.body):null});
  const path=url.slice(endpoint.length);
  const data={
   validate:{account:{id:accountId},...(agent?{agent}:{})},
   'subscribers/all':{accountId:otherId,subscribers:[{subscriptionId:'sub-1',name:'Registered User',token:'user-token-123',expiresAt:'2026-12-20T00:00:00.000Z'}]},
   'subscribers/create':{ok:true},
   'subscribers/update':{ok:true}
  }[path];
  assert.ok(data,path);
  return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
 };
 return {calls,transport};
}
test('manager validation uses exact v4.6.5 validate and subscribers endpoints, without requiring optional agent metadata',async()=>{
 const m=mockApi();const ext=new Extension(adminToken,'4.6.5',m.transport);
 const result=await ext.validate();
 assert.deepEqual(result,{accountId:'account-1',count:1});
 assert.deepEqual(m.calls.map(x=>[x.url.slice(endpoint.length),x.method]),[['validate','POST'],['subscribers/all','GET']]);
 assert.deepEqual(m.calls[0].body,{token:adminToken,version:'4.6.5'});
 assert.equal(m.calls[1].headers.Authorization,'Bearer '+adminToken);
});
test('manager token cannot silently manage a different upstream account',async()=>{
 const m=mockApi({otherId:'someone-else'}),ext=new Extension(adminToken,'4.6.5',m.transport);
 await assert.rejects(()=>ext.validate(),{code:'EXTENSION_SCOPE'});
});
test('personal token cannot be submitted as the manager credential',async()=>{
 const m=mockApi();await assert.rejects(()=>new Extension('user-token-123','4.6.5',m.transport).validate(),{code:'INVALID_ADMIN_TOKEN'});
 assert.equal(m.calls.length,0);
});
test('create and renewal use upstream v4.6.5 payload and request methods',async()=>{
 const m=mockApi(),ext=new Extension(adminToken,'4.6.5',m.transport);
 await ext.create('Customer [GY:order1]','2026-12-20T00:00:00.000Z');
 await ext.update('sub-1','2026-12-27T00:00:00.000Z');
 assert.deepEqual(m.calls.map(x=>[x.url.slice(endpoint.length),x.method,x.body]),[
  ['subscribers/create','POST',{name:'Customer [GY:order1]',expiresAt:'2026-12-20T00:00:00.000Z'}],
  ['subscribers/update','PATCH',{subscriptionId:'sub-1',expiresAt:'2026-12-27T00:00:00.000Z'}]
 ]);
});
test('customer attaches an existing token only when it appears under the configured manager account',async()=>{
 const m=mockApi(),ext=new Extension(adminToken,'4.6.5',m.transport);
 let seen;
 const ctx={extension:async()=>ext,settings:async()=>({extension_account_id:'account-1'}),encrypt:async()=>'<encrypted>',db:{rpc:async(name,args)=>{seen={name,args};return{ok:true};}}};
 await attachToken(ctx,123,'user-token-123');
 assert.equal(seen.name,'bind_token');
 assert.equal(seen.args.p_remote,'sub-1');
 assert.equal(seen.args.p_user,123);
});

test('admin validation is not blocked by unrelated legacy subscriber data',async()=>{
 const m=mockApi();
 const transport=async(url,opts)=>{
  if(url.endsWith('/subscribers/all'))return new Response(JSON.stringify({accountId:'account-1',subscribers:[{legacy:true}]}),{status:200});
  return m.transport(url,opts);
 };
 const ext=new Extension(adminToken,'4.6.5',transport);
 assert.deepEqual(await ext.validate(),{accountId:'account-1',count:1});
 await assert.rejects(()=>ext.list(),{code:'EXTENSION_SUBSCRIBER_FORMAT'});
});
test('legacy numeric subscription identifiers can be used for existing user tokens',async()=>{
 const transport=async(url)=>{
  if(url.endsWith('/subscribers/all'))return new Response(JSON.stringify({accountId:'account-1',subscribers:[{subscriptionId:42,token:'personal-token',name:'User',expiresAt:null}]}),{status:200});
  return new Response(JSON.stringify({account:{id:'account-1'}}),{status:200});
 };
 const ext=new Extension(adminToken,'4.6.5',transport);
 assert.equal((await ext.list()).subscribers[0].remote_id,'42');
 assert.equal((await ext.list()).subscribers[0].token,'personal-token');
});
test('upstream validation errors with a 200 status are not misreported as schema mismatch',async()=>{
 const transport=async()=>new Response(JSON.stringify({error:'Access denied'}),{status:200});
 await assert.rejects(()=>new Extension(adminToken,'4.6.5',transport).validate(),{code:'EXTENSION_REJECTED'});
});
test('invalid upstream response shapes identify the failing stage without exposing credentials',async()=>{
 const missingAccount=async()=>new Response(JSON.stringify({message:'success'}),{status:200});
 await assert.rejects(()=>new Extension(adminToken,'4.6.5',missingAccount).validate(),{code:'EXTENSION_VALIDATE_FORMAT'});
 const missingList=async(url)=>new Response(JSON.stringify(url.endsWith('/validate')?{account:{id:'account-1'}}:{accountId:'account-1'}),{status:200});
 await assert.rejects(()=>new Extension(adminToken,'4.6.5',missingList).validate(),{code:'EXTENSION_LIST_FORMAT'});
});
