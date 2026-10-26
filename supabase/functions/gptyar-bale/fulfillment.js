import {assert,expiry,AppError,normalizeSubscriber} from './domain.js';
import {hash} from './crypto.js';

export function subscriberDisplayName(value){
 const cleaned=String(value||'').replace(/\s*\[GY:[a-f0-9-]{36}\]\s*/gi,' ').replace(/\s+/g,' ').trim();
 assert(cleaned.length>=2&&cleaned.length<=160&&!/[<>\u0000-\u001f\u007f]/.test(cleaned),'EXTENSION_SUBSCRIBER_NAME',422);
 return cleaned;
}
// Older extension versions store whole seconds. Allow only their subsecond rounding.
const confirmed=(actual,target)=>Number.isFinite(Date.parse(actual))&&Date.parse(actual)+999>=Date.parse(target);
const scope=(listing,settings)=>assert(listing.accountId===settings.extension_account_id,'EXTENSION_SCOPE',409);
const recordScope=(record,settings)=>assert(!record?.extension_account_id||record.extension_account_id===settings.extension_account_id,'EXTENSION_SCOPE',409);
function capacity(listing,target,{create=false}={}){
 if(listing.accountType!=='ENTERPRISE')return;
 // These are the limits enforced by the supplied v4.6.5 manager UI.
 const supplied=Number(listing.limits?.maxUsers),maxUsers=Number.isInteger(supplied)&&supplied>0?supplied:20;
 assert(!create||(listing.count??listing.subscribers.length)<maxUsers,'EXTENSION_USER_LIMIT',409);
 assert(Date.parse(target)<=Date.now()+60*86400000+1000,'EXTENSION_EXPIRY_LIMIT',409);
}
export async function checkAvailability(ctx,data){
 const [client,settings]=await Promise.all([ctx.extension(),ctx.settings()]),listing=await client.list();scope(listing,settings);
 let base=null;
 if(data.subscription_id){
  const sub=await ctx.db.one('subscriptions',`id=eq.${data.subscription_id}`);recordScope(sub,settings);
  const remote=sub&&listing.subscribers.find(s=>s.remote_id===sub.remote_id);
  assert(remote?.token,'TOKEN_NOT_FOUND',404);base=remote.expires_at;
 }
 capacity(listing,expiry(base,data.days),{create:!data.subscription_id});
}
export async function attachToken(ctx,user,token){
 assert(typeof token==='string'&&token.length>=8&&token.length<=512&&!token.startsWith('@')&&!/[\s\u0000-\u001f\u007f]/.test(token),'INVALID_USER_TOKEN');
 const client=await ctx.extension(),listing=await client.list(),settings=await ctx.settings();scope(listing,settings);
 const remote=listing.subscribers.find(s=>s.token===token);assert(remote,'TOKEN_NOT_FOUND',404);
 const displayName=subscriberDisplayName(remote.name);
 const sub=await ctx.db.rpc('bind_token',{p_user:user,p_remote:remote.remote_id,p_hash:await hash(token),p_cipher:await ctx.encrypt(token,'subscriber'),p_expiry:remote.expires_at});
 return {...sub,remote_name:displayName};
}
export async function chooseSubscription(ctx,orderId,user,token){
 return ctx.lease(`order:${orderId}`,async()=>{
  const order=await ctx.db.one('orders',`id=eq.${orderId}&bale_id=eq.${user}`);
  assert(order?.paid_at,'PAYMENT_REQUIRED',409);
  assert(order.status==='paid'&&!order.remote_id&&!order.target_expires_at,'RECONCILIATION_REQUIRED',409);
  recordScope(order,await ctx.settings());
  const sub=await attachToken(ctx,user,token);
  return ctx.db.rpc('select_subscription',{p_order:orderId,p_user:user,p_subscription:sub.id,p_name:sub.remote_name});
 });
}
export async function fulfill(ctx,orderId,{reconcileOnly=false,recoveryToken=null}={}){
 return ctx.lease(`order:${orderId}`,async()=>{
  const order=await ctx.db.one('orders',`id=eq.${orderId}`);assert(order?.paid_at,'PAYMENT_REQUIRED',409);
  if(order.status==='fulfilled')return order;
  const settings=await ctx.settings();recordScope(order,settings);
  const client=await ctx.extension();
  const work=async()=>{
   const listing=await client.list();scope(listing,settings);
   let remote;
   if(order.subscription_id){
    const sub=await ctx.db.one('subscriptions',`id=eq.${order.subscription_id}&bale_id=eq.${order.bale_id}`);assert(sub,'TOKEN_NOT_OWNED',409);
    recordScope(sub,settings);
    remote=listing.subscribers.find(s=>s.remote_id===sub.remote_id);assert(remote?.token,'TOKEN_NOT_FOUND',404);
    const target=order.target_expires_at||expiry(remote.expires_at,order.days);
    await ctx.db.patch('orders',`id=eq.${order.id}`,{status:'provisioning',target_expires_at:target,error_code:null});
    if(!confirmed(remote.expires_at,target)){
     capacity(listing,target);
     await client.update(remote.upstream_id??remote.remote_id,target);
     const after=await client.list();scope(after,settings);remote=after.subscribers.find(s=>s.remote_id===sub.remote_id);
    }
    assert(remote&&confirmed(remote.expires_at,target),'EXTENSION_NOT_CONFIRMED',502);
   }else if(order.remote_id){
    // The successful create response identifies this account even if the following GET failed.
    remote=listing.subscribers.find(s=>s.remote_id===order.remote_id);
    assert(remote&&confirmed(remote.expires_at,order.target_expires_at),'EXTENSION_NOT_CONFIRMED',502);
   }else if(recoveryToken){
    // Explicit administrator recovery of an ambiguous create; never match by name alone.
    assert(['review','provisioning'].includes(order.status)&&order.target_expires_at,'RECONCILIATION_REQUIRED',409);
    remote=listing.subscribers.find(s=>s.token===recoveryToken);
    assert(remote?.token,'TOKEN_NOT_FOUND',404);
    assert(!order.creation_known_ids?.includes(remote.remote_id),'TOKEN_ALREADY_FULFILLED',409);
    const priorSub=await ctx.db.one('subscriptions',`remote_id=eq.${encodeURIComponent(remote.remote_id)}&extension_account_id=eq.${encodeURIComponent(settings.extension_account_id)}`);
    if(priorSub){const prior=await ctx.db.one('orders',`subscription_id=eq.${priorSub.id}&kind=eq.purchase&status=eq.fulfilled`);assert(!prior,'TOKEN_ALREADY_FULFILLED',409);}
    assert(subscriberDisplayName(remote.name)===subscriberDisplayName(order.full_name),'RECOVERY_NAME_MISMATCH',409);
    assert(confirmed(remote.expires_at,order.target_expires_at),'EXTENSION_NOT_CONFIRMED',409);
    const used=await ctx.db.one('orders',`remote_id=eq.${encodeURIComponent(remote.remote_id)}&extension_account_id=eq.${encodeURIComponent(settings.extension_account_id)}&kind=eq.purchase&id=neq.${order.id}`);
    assert(!used,'TOKEN_ALREADY_FULFILLED',409);
    await ctx.db.patch('orders',`id=eq.${order.id}`,{remote_id:remote.remote_id});
   }else{
    assert(!reconcileOnly&&!['provisioning','review'].includes(order.status),'RECONCILIATION_REQUIRED',409);
    const target=order.target_expires_at||expiry(null,order.days);
    remote=await ctx.lease('extension:create',async()=>{
     const before=await client.list();scope(before,settings);capacity(before,target,{create:true});
     const known=new Set(before.subscribers.map(s=>s.remote_id));
     await ctx.db.patch('orders',`id=eq.${order.id}`,{status:'provisioning',target_expires_at:target,creation_known_ids:[...known],error_code:null});
     let result;
     try{result=await client.create(order.full_name,target);}
     catch(e){if(e.definiteRejection)await ctx.db.patch('orders',`id=eq.${order.id}`,{status:'paid',error_code:e.code});throw e;}
     const created=normalizeSubscriber(result);
     assert(created.token&&!known.has(created.remote_id)&&created.name===order.full_name,'RECONCILIATION_REQUIRED',409);
     // Save the returned ID before any further upstream request. Never infer ownership from a name.
     await ctx.db.patch('orders',`id=eq.${order.id}`,{remote_id:created.remote_id});
     const after=await client.list();scope(after,settings);
     const saved=after.subscribers.find(s=>s.remote_id===created.remote_id);
     assert(saved?.token&&confirmed(saved.expires_at,target),'EXTENSION_NOT_CONFIRMED',502);
     return saved;
    });
   }
   assert(remote?.token,'EXTENSION_CONTRACT',502);
   return ctx.db.rpc('complete',{p_order:order.id,p_remote:remote.remote_id,p_hash:await hash(remote.token),p_cipher:await ctx.encrypt(remote.token,'subscriber'),p_expiry:remote.expires_at});
  };
  try{return order.subscription_id?await ctx.lease(`subscription:${order.subscription_id}`,work):await work();}
  catch(e){
   const fresh=await ctx.db.one('orders',`id=eq.${order.id}`);
   if(fresh?.status!=='fulfilled')await ctx.db.patch('orders',`id=eq.${order.id}`,{...(fresh?.status==='provisioning'?{status:'review'}:{}),error_code:e.code||'FULFILLMENT_ERROR'});
   await ctx.audit('subscription.needs_review',order.bale_id,{order_id:order.id,code:e.code||'FULFILLMENT_ERROR'});throw e;
  }
 });
}
export async function deliver(ctx,order,{force=false}={}){
 assert(order.status==='fulfilled'&&order.subscription_id,'NOT_FULFILLED',409);
 if(order.delivery_sent_at&&!force)return{already_sent:true};
 const sub=await ctx.db.one('subscriptions',`id=eq.${order.subscription_id}&bale_id=eq.${order.bale_id}`);assert(sub,'TOKEN_NOT_OWNED');
 const token=await ctx.decrypt(sub.token_ciphertext,'subscriber'),date=new Date(sub.expires_at).toLocaleString('fa-IR',{timeZone:'Asia/Tehran'});
 try{
  const message=await(await ctx.bale()).send(order.bale_id,`${order.kind==='renewal'?'اشتراک شما تمدید شد ✅':'توکن شما آماده است ✅'}\nمدت: ${order.days} روز\nاعتبار تا: ${date}\n\nتوکن شخصی شما:\n${token}\n\nاین توکن را فقط در اکستنشن خود وارد کنید و در اختیار دیگران قرار ندهید.\nکد سفارش: ${order.id}`,[['خرید اشتراک','تمدید با توکن'],['دریافت مجدد توکن','سفارش‌های من'],['پشتیبانی']]);
  await ctx.db.patch('orders',`id=eq.${order.id}`,{delivery_sent_at:new Date().toISOString(),delivery_error_code:null});return message;
 }catch(e){
  await ctx.db.patch('orders',`id=eq.${order.id}`,{delivery_error_code:e.code||'DELIVERY_FAILED'}).catch(()=>{});
  throw new AppError('DELIVERY_FAILED',502);
 }
}
