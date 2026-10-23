import test from 'node:test';
import assert from 'node:assert/strict';
import {fulfill} from '../supabase/functions/gptyar-bale/fulfillment.js';
import {AppError} from '../supabase/functions/gptyar-bale/domain.js';
const id='1b2b7e78-6ab8-47e6-bf25-d6487e2e3377';
function fixture({renewal=false,failCreate=false,createRemotely=true,failUpdate=false}={}){
 const order={id,bale_id:123,full_name:'Test User',days:7,kind:renewal?'renewal':'purchase',status:'paid',paid_at:new Date().toISOString(),subscription_id:renewal?'sub1':null};
 const remote={remote_id:'r1',token:'user-token',name:renewal?'Existing Subscriber':'Test User',expires_at:'2026-12-01T00:00:00.000Z'};
 let subscribers=renewal?[remote]:[],creates=0,updates=0,completions=0;
 const client={list:async()=>({accountId:'a1',subscribers}),create:async(name,expires_at)=>{creates++;if(createRemotely)subscribers=[{...remote,name,expires_at}];if(failCreate)throw new AppError('EXTENSION_UNREACHABLE',502);},update:async(r,target)=>{updates++;remote.expires_at=target;if(failUpdate)throw new AppError('EXTENSION_UNREACHABLE',502);}};
 const ctx={lease:async(k,fn)=>fn(),extension:async()=>client,settings:async()=>({extension_account_id:'a1'}),encrypt:async s=>'sealed:'+s,audit:async()=>{},db:{
  one:async(table)=>table==='orders'?{...order}:table==='subscriptions'?{id:'sub1',bale_id:123,remote_id:'r1'}:null,
  patch:async(table,q,value)=>{if(table==='orders')Object.assign(order,value);return[{...order}];},
  rpc:async(name,args)=>{assert.equal(name,'complete');completions++;Object.assign(order,{status:'fulfilled',subscription_id:'sub1',target_expires_at:args.p_expiry});return{...order};}
 }};
 return{ctx,order,remote,counts:()=>({creates,updates,completions})};
}
test('replaying an already fulfilled purchase cannot create another user',async()=>{
 const f=fixture();await fulfill(f.ctx,id);await fulfill(f.ctx,id);assert.deepEqual(f.counts(),{creates:1,updates:0,completions:1});
});
test('an ambiguous create is held for manual review when names cannot carry order markers',async()=>{
 const f=fixture({failCreate:true});await assert.rejects(()=>fulfill(f.ctx,id));assert.equal(f.order.status,'review');
 await assert.rejects(()=>fulfill(f.ctx,id,{reconcileOnly:true}),{code:'RECONCILIATION_REQUIRED'});
 assert.deepEqual(f.counts(),{creates:1,updates:0,completions:0});
});
test('ambiguous creates are never automatically sent again',async()=>{
 const f=fixture({failCreate:true,createRemotely:false});await assert.rejects(()=>fulfill(f.ctx,id));
 await assert.rejects(()=>fulfill(f.ctx,id),{code:'RECONCILIATION_REQUIRED'});assert.equal(f.counts().creates,1);
});
test('renewal retries use the persisted absolute expiration and cannot add days twice',async()=>{
 const f=fixture({renewal:true,failUpdate:true});await assert.rejects(()=>fulfill(f.ctx,id));const target=f.order.target_expires_at;
 await fulfill(f.ctx,id,{reconcileOnly:true});assert.equal(f.order.target_expires_at,target);assert.equal(f.remote.expires_at,target);assert.equal(f.counts().updates,1);
});
test('an unpaid order cannot call the extension',async()=>{
 const f=fixture();f.order.paid_at=null;await assert.rejects(()=>fulfill(f.ctx,id),{code:'PAYMENT_REQUIRED'});assert.equal(f.counts().creates,0);
});

test('new subscription is created using only the submitted first and last name',async()=>{
 const f=fixture();await fulfill(f.ctx,id);
 assert.equal(f.remote.name,'Test User');
 assert.deepEqual(f.counts(),{creates:1,updates:0,completions:1});
});
