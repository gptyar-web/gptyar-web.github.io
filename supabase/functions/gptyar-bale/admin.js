import {assert,integer,url} from './domain.js';
import {Bale,Extension} from './clients.js';
import {random,passwordHash,passwordVerify,totpCounter,hash} from './crypto.js';
import {fulfill,deliver} from './fulfillment.js';
import {reconcilePayment} from './bot.js';
export async function adminRoute(ctx,path,req,b,auth){
 const actor=auth.admin.username;
 if(req.method==='GET'&&['/overview','/orders'].includes(path))await ctx.db.patch('orders',`status=eq.pending&expires_at=lt.${new Date().toISOString()}`,{status:'expired'});
 if(path==='/me'&&req.method==='GET')return{username:actor,expires_at:auth.session.expires_at};
 if(path==='/auth/logout'&&req.method==='POST'){await ctx.db.delete('sessions',`token_hash=eq.${auth.tokenHash}`);return{ok:true};}
 if(path==='/auth/password'&&req.method==='POST'){
  await ctx.rate(`password:${auth.admin.id}`,5);
  assert(typeof b.password==='string'&&b.password.length>=12&&b.password.length<=128,'WEAK_PASSWORD');
  assert(await passwordVerify(String(b.current_password||''),auth.admin.password_hash),'AUTH_DENIED',401);
  const counter=await totpCounter(await ctx.decrypt(auth.admin.totp_secret,'totp'),String(b.code||''));assert(counter!==null,'INVALID_OTP');
  const changed=await ctx.db.patch('admins',`id=eq.${auth.admin.id}&last_totp_counter=lt.${counter}`,{password_hash:await passwordHash(b.password),last_totp_counter:counter});assert(changed.length===1,'OTP_REPLAY');
  await ctx.db.delete('sessions',`admin_id=eq.${auth.admin.id}`);await ctx.audit('auth.password_changed',actor);return{ok:true};
 }
 if(path==='/overview'&&req.method==='GET'){
  const [metrics,recent,settings,secrets]=await Promise.all([ctx.db.rpc('dashboard'),ctx.db.list('orders','select=id,full_name,kind,days,total_toman,status,created_at&order=created_at.desc&limit=6'),ctx.settings(),ctx.db.list('secrets','select=key,updated_at')]);
  return{metrics,recent,settings,integrations:secrets.map(s=>({key:s.key,updated_at:s.updated_at}))};
 }
 const query=new URL(req.url).searchParams;
 if(path==='/orders'&&req.method==='GET'){
  const page=integer(query.get('page')||1,1,10000),status=query.get('status')||'';assert(!status||['pending','checkout','paid','fulfilled','review','provisioning','expired','cancelled'].includes(status),'INVALID_STATUS');
  const q=new URLSearchParams({select:'id,bale_id,full_name,kind,days,subtotal_toman,discount_toman,total_toman,status,created_at,paid_at,fulfilled_at,target_expires_at,error_code,charge_id',order:'created_at.desc',limit:'26',offset:String((page-1)*25)});if(status)q.set('status','eq.'+status);
  const search=(query.get('q')||'').trim();if(search){assert(search.length<=80&&!/[(),]/.test(search),'INVALID_SEARCH');if(/^\d+$/.test(search))q.set('bale_id','eq.'+search);else if(/^[a-f0-9-]{36}$/.test(search))q.set('id','eq.'+search);else q.set('full_name','ilike.*'+search.replace(/[%*_]/g,'')+'*');}
  const rows=await ctx.db.list('orders',q.toString());return{rows:rows.slice(0,25),has_more:rows.length>25,page};
 }
 const orderMatch=path.match(/^\/orders\/([a-f0-9-]{36})\/(reconcile|cancel|deliver|payment)$/);
 if(orderMatch&&req.method==='POST'){
  const [,id,action]=orderMatch,order=await ctx.db.one('orders',`id=eq.${id}`);assert(order,'NOT_FOUND',404);
  if(action==='payment'){const result=await reconcilePayment(ctx,order);await ctx.audit('order.payment_checked',actor,{order_id:id,status:result.payment_status});return result;}
  if(action==='cancel'){assert(order.status==='pending'&&!order.paid_at,'CANNOT_CANCEL',409);await ctx.db.patch('orders',`id=eq.${id}&status=eq.pending`,{status:'cancelled'});}
  else if(action==='deliver'){await deliver(ctx,order);}
  else {const done=await fulfill(ctx,id,{reconcileOnly:['review','provisioning'].includes(order.status)});await deliver(ctx,done);}
  await ctx.audit('order.'+action,actor,{order_id:id});return{ok:true};
 }
 if(path==='/customers'&&req.method==='GET'){
  const page=integer(query.get('page')||1,1,10000);const rows=await ctx.db.list('customers',`select=bale_id,first_name,last_name,os,created_at,gpyb_subscriptions(id,remote_id,expires_at)&order=created_at.desc&limit=26&offset=${(page-1)*25}`);return{rows:rows.slice(0,25),has_more:rows.length>25,page};
 }
 if(path==='/coupons'&&req.method==='GET'){
  const [rows,orders]=await Promise.all([ctx.db.list('coupons','order=created_at.desc&limit=200'),ctx.db.list('orders','coupon_id=not.is.null&select=coupon_id,status,paid_at,expires_at&limit=10000')]);
  return{rows:rows.map(c=>({...c,used:orders.filter(o=>o.coupon_id===c.id&&o.paid_at).length,reserved:orders.filter(o=>o.coupon_id===c.id&&!o.paid_at&&(o.status==='checkout'||o.status==='pending'&&Date.parse(o.expires_at)>Date.now())).length}))};
 }
 if(path==='/coupons'&&req.method==='POST'){
  const code=String(b.code||'').trim().toUpperCase();assert(/^[A-Z0-9_-]{3,32}$/.test(code),'INVALID_COUPON_CODE');assert(['percent','fixed'].includes(b.kind),'INVALID_DISCOUNT');
  const value=integer(b.value,1,b.kind==='percent'?100:10000000),max=integer(b.max_uses,1,1000000),per=integer(b.per_user_limit||1,1,max);assert(Object.hasOwn(b,'expires_at'),'INVALID_EXPIRY');const noExpiry=b.expires_at===null;const end=noExpiry?null:Date.parse(b.expires_at);assert(noExpiry||(typeof b.expires_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(b.expires_at)&&Number.isFinite(end)&&end>Date.now()),'INVALID_EXPIRY');
  const rows=await ctx.db.insert('coupons',{code,kind:b.kind,value,max_uses:max,per_user_limit:per,expires_at:noExpiry?null:new Date(end).toISOString()});await ctx.audit('coupon.created',actor,{code});return{row:rows[0]};
 }
 const coupon=path.match(/^\/coupons\/([a-f0-9-]{36})$/);
 if(coupon&&req.method==='PATCH'){assert(typeof b.active==='boolean','INVALID_INPUT');await ctx.db.patch('coupons',`id=eq.${coupon[1]}`,{active:b.active});await ctx.audit('coupon.updated',actor,{id:coupon[1],active:b.active});return{ok:true};}
 if(path==='/settings'&&req.method==='GET'){
  const [settings,links,secrets]=await Promise.all([ctx.settings(),ctx.db.list('links','order=os'),ctx.db.list('secrets','select=key,updated_at')]);return{settings,links,integrations:secrets.filter(s=>s.key!=='webhook')};
 }
 if(path==='/settings'&&req.method==='PATCH'){
  const update={};
  if(b.daily_price_toman!==undefined)update.daily_price_toman=integer(b.daily_price_toman,1000,10000000);
  if(b.max_days!==undefined)update.max_days=integer(b.max_days,1,3650);
  if(b.extension_version!==undefined){assert(/^\d+\.\d+\.\d+$/.test(b.extension_version),'INVALID_VERSION');update.extension_version=b.extension_version;}
  if(b.support_eitaa!==undefined)update.support_eitaa=url(b.support_eitaa);
  if(b.support_divar!==undefined)update.support_divar=url(b.support_divar);
  if(b.sales_enabled!==undefined){assert(typeof b.sales_enabled==='boolean','INVALID_INPUT');if(b.sales_enabled)assert(await ctx.ready(),'INTEGRATIONS_REQUIRED',409);update.sales_enabled=b.sales_enabled;}
  update.updated_at=new Date().toISOString();await ctx.db.patch('settings','id=eq.true',update);await ctx.audit('settings.updated',actor,{fields:Object.keys(update)});return{ok:true};
 }
 if(path==='/links'&&req.method==='PUT'){
  assert(Array.isArray(b.links)&&b.links.length===4&&new Set(b.links.map(x=>x.os)).size===4,'INVALID_INPUT');
  const allowed={android:'اندروید',ios:'آیفون',windows:'ویندوز',mac:'مک'};
  const rows=b.links.map(l=>{assert(allowed[l.os]&&typeof l.note==='string'&&l.note.length<=500,'INVALID_INPUT');return{os:l.os,title:allowed[l.os],tutorial_url:url(l.tutorial_url),download_url:url(l.download_url),note:l.note};});
  await ctx.db.upsert('links',rows,'os');await ctx.audit('links.updated',actor);return{ok:true};
 }
 if(path==='/integrations'&&req.method==='POST'){
  assert(['bale_bot','bale_payment','extension_admin'].includes(b.kind)&&typeof b.token==='string','INVALID_INPUT');const token=b.token.trim();
  await ctx.rate('integration:'+actor,20,300);const settings=await ctx.settings();
  if(b.kind==='bale_bot'){
   assert(/^\d+:[A-Za-z0-9_-]{20,200}$/.test(token),'INVALID_BOT_TOKEN');const client=new Bale(token,ctx.transport),me=await client.call('getMe');assert(me.is_bot&&me.id,'INVALID_BOT_TOKEN');
   const secret=random(),webhook=`${ctx.env.SUPABASE_URL}/functions/v1/gptyar-bale/webhook/${secret}`;
   await client.call('setWebhook',{url:webhook});
   try{await ctx.saveSecret('webhook',secret);await ctx.saveSecret('bale_bot',token);await ctx.db.patch('settings','id=eq.true',{bot_username:me.username||'',bot_id:me.id,connected_at:new Date().toISOString()});}catch(e){await client.call('deleteWebhook').catch(()=>{});throw e;}
   await ctx.audit('integration.bale_connected',actor,{username:me.username});return{ok:true,username:me.username};
  }
  if(b.kind==='bale_payment'){
   assert(token.length>=10&&token.length<=300&&!/\s/.test(token)&&!token.startsWith('WALLET-TEST-'),'INVALID_PAYMENT_TOKEN');
   await ctx.saveSecret('bale_payment',token);await ctx.audit('integration.payment_saved',actor);return{ok:true,verified:false};
  }
  const client=new Extension(token,settings.extension_version,ctx.transport),result=await client.validate();
  // Existing subscriptions must never silently move to another upstream account.
  if(settings.extension_account_id&&settings.extension_account_id!==result.accountId)assert(!(await ctx.db.list('subscriptions','select=id&limit=1')).length,'EXTENSION_ACCOUNT_LOCKED',409);
  await ctx.saveSecret('extension_admin',token);await ctx.db.patch('settings','id=eq.true',{extension_account_id:result.accountId});await ctx.audit('integration.extension_connected',actor,{account_id:result.accountId});return{ok:true,account_id:result.accountId,count:result.count};
 }
 if(path==='/integrations/check'&&req.method==='POST'){
  const result={};
  try{const bot=await ctx.bale(),me=await bot.call('getMe'),info=await bot.call('getWebhookInfo'),secret=await ctx.secret('webhook');result.bale_bot={ok:!!me.is_bot&&info.url===`${ctx.env.SUPABASE_URL}/functions/v1/gptyar-bale/webhook/${secret}`,username:me.username};}catch(e){result.bale_bot={ok:false,code:e.code};}
  try{const client=await ctx.extension(),d=await client.validate(),s=await ctx.settings();result.extension_admin={ok:d.accountId===s.extension_account_id,count:d.count};}catch(e){result.extension_admin={ok:false,code:e.code};}
  result.bale_payment={saved:!!await ctx.secret('bale_payment'),verified:false};return result;
 }
 if(path==='/audit'&&req.method==='GET'){const page=integer(query.get('page')||1,1,10000),rows=await ctx.db.list('audit',`order=created_at.desc&limit=26&offset=${(page-1)*25}`);return{rows:rows.slice(0,25),has_more:rows.length>25,page};}
 return null;
}
