import test from 'node:test';
import assert from 'node:assert/strict';
import {Extension} from '../supabase/functions/gptyar-bale/clients.js';
import {fulfill} from '../supabase/functions/gptyar-bale/fulfillment.js';

// The actual extension passes subscriptionId from subscribers/all to PATCH unchanged.
// Database identifiers remain text; their storage representation is not the API wire type.
function renewalFixture(upstreamId){
 const target='2026-11-04T20:30:00.000Z';
 const subscriber={subscriptionId:upstreamId,token:'personal-test-token',name:'Test User',expiresAt:'2026-10-28T20:30:00.000Z'};
 const order={id:'11111111-1111-4111-8111-111111111111',bale_id:123,kind:'renewal',full_name:'Test User',subscription_id:'local-sub',days:7,status:'review',paid_at:'2026-10-23T14:23:00.000Z',target_expires_at:target};
 const sent=[];let completions=0;
 const transport=async(url,opts)=>{
  if(url.endsWith('/subscribers/all'))return Response.json({accountId:'account1',subscribers:[subscriber]});
  assert.ok(url.endsWith('/subscribers/update'));assert.equal(opts.method,'PATCH');
  const body=JSON.parse(opts.body);sent.push(body);
  if(typeof body.subscriptionId!==typeof upstreamId||body.subscriptionId!==upstreamId)return Response.json({error:'Invalid subscriptionId'},{status:400});
  subscriber.expiresAt=body.expiresAt;return Response.json({subscriptionId:upstreamId,expiresAt:body.expiresAt});
 };
 const ext=new Extension('@manager-test','4.6.5',transport);
 const ctx={lease:async(k,fn)=>fn(),extension:async()=>ext,settings:async()=>({extension_account_id:'account1'}),encrypt:async()=>'<cipher>',audit:async()=>{},db:{
  one:async(table)=>table==='orders'?{...order}:{id:'local-sub',bale_id:123,remote_id:String(upstreamId)},
  patch:async(table,q,body)=>{Object.assign(order,body);return[{...order}];},
  rpc:async(method,p)=>{assert.equal(method,'complete');assert.equal(p.p_remote,String(upstreamId));completions++;Object.assign(order,{status:'fulfilled'});return{...order};}
 }};
 return{ctx,order,subscriber,sent,target,counts:()=>({completions})};
}
test('renewal preserves a numeric upstream subscription ID through normalization, storage lookup and PATCH',async()=>{
 const f=renewalFixture(42001);
 await fulfill(f.ctx,f.order.id,{reconcileOnly:true});
 assert.equal(f.sent[0].subscriptionId,42001);assert.equal(typeof f.sent[0].subscriptionId,'number');
 assert.equal(f.subscriber.expiresAt,f.target);assert.equal(f.order.status,'fulfilled');
 await fulfill(f.ctx,f.order.id,{reconcileOnly:true});assert.equal(f.sent.length,1);assert.equal(f.counts().completions,1);
});
test('opaque and numeric-looking string IDs keep the exact type supplied by the upstream API',async()=>{
 for(const value of ['subscriber-42001','0042001','42001']){
  const f=renewalFixture(value);await fulfill(f.ctx,f.order.id,{reconcileOnly:true});
  assert.equal(f.sent[0].subscriptionId,value);assert.equal(typeof f.sent[0].subscriptionId,'string');
 }
});
