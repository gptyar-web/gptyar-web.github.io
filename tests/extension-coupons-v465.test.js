import test from 'node:test';
import assert from 'node:assert/strict';
import {Extension} from '../supabase/functions/gptyar-bale/clients.js';
import {adminRoute} from '../supabase/functions/gptyar-bale/admin.js';

function extensionTransport({accountId=17,listedId=17,authorized=true}={}){
 const calls=[];
 const transport=async (url,options)=>{
  calls.push({url,options});
  if(!authorized)return Response.json({error:'unauthorized'},{status:401});
  if(url.endsWith('/accupdator/validate'))return Response.json({account:{id:accountId},agent:{id:'admin-agent'}});
  if(url.endsWith('/accupdator/subscribers/all'))return Response.json({accountId:listedId,subscribers:[
   {subscriptionId:'subscription-1',token:'user-token-1',name:'Test',expiresAt:null}
  ]});
  throw Error('Unexpected endpoint: '+url);
 };
 return {calls,transport};
}

test('v4.6.5 token validation uses POST token/version plus bearer-authorized subscribers/all',async ()=>{
 const {calls,transport}=extensionTransport();
 const value=await new Extension('@admin-example','4.6.5',transport).validate();
 assert.deepEqual(value,{accountId:'17',count:1});
 assert.equal(calls.length,2);
 assert.equal(calls[0].url,'https://api.gptyar.com/accupdator/validate');
 assert.equal(calls[0].options.method,'POST');
 assert.equal(calls[0].options.headers.Authorization,'Bearer @admin-example');
 assert.deepEqual(JSON.parse(calls[0].options.body),{token:'@admin-example',version:'4.6.5'});
 assert.equal(calls[1].url,'https://api.gptyar.com/accupdator/subscribers/all');
 assert.equal(calls[1].options.method,'GET');
});

test('v4.6.5 validates management prefix before any network request',async ()=>{
 const {calls,transport}=extensionTransport();
 await assert.rejects(new Extension('user-token','4.6.5',transport).validate(),{code:'INVALID_ADMIN_TOKEN'});
 assert.equal(calls.length,0);
});

test('v4.6.5 rejects tokens belonging to another account',async ()=>{
 const {transport}=extensionTransport({listedId:22});
 await assert.rejects(new Extension('@admin-example','4.6.5',transport).validate(),{code:'EXTENSION_SCOPE'});
});

test('v4.6.5 rejects unauthorized upstream token',async ()=>{
 const {transport}=extensionTransport({authorized:false});
 await assert.rejects(new Extension('@admin-example','4.6.5',transport).validate(),{code:'EXTENSION_UNAUTHORIZED'});
});

function couponContext(){
 let inserted=null;
 const ctx={db:{insert:async (table,rows)=>{assert.equal(table,'coupons');inserted=rows;return[{id:'example',...rows}];}},
 audit:async ()=>{}};
 return{ctx,inserted:()=>inserted};
}
const req={method:'POST',url:'https://example.test/coupons'},auth={admin:{username:'tester'}};
const coupon={code:'FOREVER',kind:'percent',value:10,max_uses:100,per_user_limit:1};

test('coupon API stores null expiry for unlimited coupons',async ()=>{
 const {ctx,inserted}=couponContext();
 const result=await adminRoute(ctx,'/coupons',req,{...coupon,expires_at:null},auth);
 assert.equal(inserted().expires_at,null);
 assert.equal(result.row.code,'FOREVER');
});

test('coupon API stores exact UTC expiry for dated coupons',async ()=>{
 const {ctx,inserted}=couponContext();
 const when=new Date(Date.now()+3*86400000).toISOString();
 await adminRoute(ctx,'/coupons',req,{...coupon,expires_at:when},auth);
 assert.equal(inserted().expires_at,when);
});

test('coupon API rejects missing or past expiry',async ()=>{
 const {ctx}=couponContext();
 await assert.rejects(adminRoute(ctx,'/coupons',req,coupon,auth),{code:'INVALID_EXPIRY'});
 await assert.rejects(adminRoute(ctx,'/coupons',req,{...coupon,expires_at:'2020-01-01T00:00:00.000Z'},auth),{code:'INVALID_EXPIRY'});
});
