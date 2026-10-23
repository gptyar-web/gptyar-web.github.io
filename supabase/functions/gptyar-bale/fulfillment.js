import {assert,expiry,AppError} from './domain.js';
import {hash} from './crypto.js';
export async function attachToken(ctx,user,token){
 assert(typeof token==='string'&&token.length>=8&&token.length<=512&&!token.startsWith('@')&&!/[\s\u0000-\u001f]/.test(token),'INVALID_USER_TOKEN');
 const client=await ctx.extension(),listing=await client.list(),settings=await ctx.settings();assert(listing.accountId===settings.extension_account_id,'EXTENSION_SCOPE',409);
 const remote=listing.subscribers.find(s=>s.token===token);assert(remote,'TOKEN_NOT_FOUND',404);
 const fingerprint=await hash(token);return ctx.db.rpc('bind_token',{p_user:user,p_remote:remote.remote_id,p_hash:fingerprint,p_cipher:await ctx.encrypt(token,'subscriber'),p_expiry:remote.expires_at});
}
export async function fulfill(ctx,orderId,{reconcileOnly=false}={}){
 return ctx.lease(`order:${orderId}`,async()=>{
  let order=await ctx.db.one('orders',`id=eq.${orderId}`);assert(order?.paid_at,'PAYMENT_REQUIRED',409);
  if(order.status==='fulfilled')return order;
  const client=await ctx.extension();
  const work=async()=>{
   const listing=await client.list(),settings=await ctx.settings();assert(listing.accountId===settings.extension_account_id,'EXTENSION_SCOPE',409);
   let remote;
   if(order.subscription_id){
    const sub=await ctx.db.one('subscriptions',`id=eq.${order.subscription_id}&bale_id=eq.${order.bale_id}`);assert(sub,'TOKEN_NOT_OWNED',409);
    remote=listing.subscribers.find(s=>s.remote_id===sub.remote_id);assert(remote,'TOKEN_NOT_FOUND',404);
    const target=order.target_expires_at||expiry(remote.expires_at,order.days);
    await ctx.db.patch('orders',`id=eq.${order.id}`,{status:'provisioning',target_expires_at:target});
    // The absolute target is persisted before PATCH. Retrying cannot add days twice.
    if((Date.parse(remote.expires_at)||0)<Date.parse(target))await client.update(remote.remote_id,target);
    remote=(await client.list()).subscribers.find(s=>s.remote_id===sub.remote_id);
    assert(remote&&Date.parse(remote.expires_at)>=Date.parse(target),'EXTENSION_NOT_CONFIRMED',502);
   }else{
    const marker=`[GY:${order.id}]`;
    const matches=listing.subscribers.filter(s=>s.name.includes(marker));assert(matches.length<=1,'EXTENSION_DUPLICATE',409);remote=matches[0];
    if(!remote){
     // A timeout or interrupted create needs reconciliation; never blindly create again.
     assert(!reconcileOnly&&!['provisioning','review'].includes(order.status),'RECONCILIATION_REQUIRED',409);
     const target=expiry(null,order.days);await ctx.db.patch('orders',`id=eq.${order.id}`,{status:'provisioning',target_expires_at:target});
     try{await client.create(`${order.full_name} ${marker}`,target);}catch(e){if(e.definiteRejection)await ctx.db.patch('orders',`id=eq.${order.id}`,{status:'paid',error_code:e.code});throw e;}
     const found=(await client.list()).subscribers.filter(s=>s.name.includes(marker));assert(found.length===1,'RECONCILIATION_REQUIRED',409);remote=found[0];
     assert(Date.parse(remote.expires_at)>=Date.parse(target),'EXTENSION_NOT_CONFIRMED',502);
    }
   }
   assert(remote?.token,'EXTENSION_CONTRACT',502);
   return ctx.db.rpc('complete',{p_order:order.id,p_remote:remote.remote_id,p_hash:await hash(remote.token),p_cipher:await ctx.encrypt(remote.token,'subscriber'),p_expiry:remote.expires_at});
  };
  try{return order.subscription_id?await ctx.lease(`subscription:${order.subscription_id}`,work):await work();}
  catch(e){const fresh=await ctx.db.one('orders',`id=eq.${order.id}`);if(fresh?.status==='provisioning')await ctx.db.patch('orders',`id=eq.${order.id}`,{status:'review',error_code:e.code||'FULFILLMENT_ERROR'});await ctx.audit('subscription.needs_review',order.bale_id,{order_id:order.id,code:e.code||'FULFILLMENT_ERROR'});throw e;}
 });
}
export async function deliver(ctx,order){
 assert(order.status==='fulfilled'&&order.subscription_id,'NOT_FULFILLED',409);
 const sub=await ctx.db.one('subscriptions',`id=eq.${order.subscription_id}&bale_id=eq.${order.bale_id}`);assert(sub,'TOKEN_NOT_OWNED');
 const token=await ctx.decrypt(sub.token_ciphertext,'subscriber'),date=new Date(sub.expires_at).toLocaleString('fa-IR',{timeZone:'Asia/Tehran'});
 return(await ctx.bale()).send(order.bale_id,`${order.kind==='renewal'?'اشتراک شما تمدید شد ✅':'توکن شما آماده است ✅'}\nمدت: ${order.days} روز\nاعتبار تا: ${date}\n\nتوکن شخصی شما:\n${token}\n\nاین توکن را فقط در اکستنشن خود وارد کنید و در اختیار دیگران قرار ندهید.\nکد سفارش: ${order.id}`,[['خرید اشتراک','تمدید با توکن'],['سفارش‌های من','پشتیبانی']]);
}
