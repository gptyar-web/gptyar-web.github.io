import {assert,integer,name,verifyPayment,LABELS} from './domain.js';
import {attachToken,fulfill,deliver} from './fulfillment.js';
const MENU=[['خرید اشتراک','تمدید با توکن'],['ثبت توکن پس از پرداخت','سفارش‌های من'],['آموزش و دانلود','پشتیبانی']];
const OS=[['اندروید','آیفون'],['ویندوز','مک']];
const YESNO=[['بله','خیر'],['لغو']];
const TOKEN=[['دریافت توکن جدید','ثبت توکن موجود'],['منوی اصلی']];
const money=n=>Number(n).toLocaleString('fa-IR');
const ERRORS={INVALID_NUMBER:'لطفاً تعداد روز را با یک عدد صحیح و در محدوده مجاز ارسال کنید.',INVALID_NAME:'نام باید بین ۲ تا ۶۰ نویسه باشد.',INVALID_COUPON:'کد تخفیف نامعتبر یا منقضی است. کد دیگری ارسال کنید یا «بدون تخفیف» را بزنید.',COUPON_EXHAUSTED:'ظرفیت این کد تکمیل شده است. کد دیگری بفرستید یا «بدون تخفیف» را بزنید.',COUPON_USER_LIMIT:'سهم استفاده شما از این کد به پایان رسیده است.',INVALID_USER_TOKEN:'توکن کاربری معتبر را ارسال کنید. توکن مدیریتی قابل استفاده نیست.',EXTENSION_SUBSCRIBER_NAME:'نام اشتراک در اکستنشن خالی یا نامعتبر است؛ لطفاً از پشتیبانی بخواهید نام را در اکستنشن اصلاح کند.',TOKEN_NOT_FOUND:'این توکن در حساب مدیریتی سرویس پیدا نشد. توکن را بررسی کنید یا با پشتیبانی تماس بگیرید.',TOKEN_NOT_OWNED:'این توکن قبلاً به کاربر دیگری متصل شده است. برای بررسی مالکیت با پشتیبانی تماس بگیرید.',SALES_DISABLED:'خرید در حال حاضر غیرفعال است. لطفاً بعداً مراجعه کنید یا با پشتیبانی تماس بگیرید.',INTEGRATIONS_REQUIRED:'اتصال سرویس هنوز کامل نشده است. لطفاً با پشتیبانی تماس بگیرید.',NO_PAID_ORDER:'سفارش پرداخت‌شده‌ای برای ثبت توکن ندارید. ابتدا خرید و پرداخت را کامل کنید.'};
export async function preCheckout(ctx,q){
 const bale=await ctx.bale();let ok=false;
 if(q&&Number.isSafeInteger(q.from?.id)&&q.from.id>0&&Number.isSafeInteger(q.total_amount)&&q.total_amount>0&&/^[a-f0-9-]{36}$/.test(q.invoice_payload||'')&&await ctx.ready())ok=await ctx.db.rpc('precheckout',{p_order:q.invoice_payload,p_user:q.from.id,p_charge:String(q.id),p_amount:q.total_amount,p_currency:q.currency});
 await bale.call('answerPreCheckoutQuery',{pre_checkout_query_id:String(q.id),ok,...(!ok?{error_message:'سفارش یا مبلغ پرداخت معتبر نیست، خرید غیرفعال است یا اعتبار صورتحساب پایان یافته؛ از ربات صورتحساب جدید بگیرید.'}:{})});
}
async function state(ctx,user,step,data={}){return ctx.db.upsert('conversations',{bale_id:user,state:step,data,updated_at:new Date().toISOString()},'bale_id');}
async function paidOrder(ctx,user){return ctx.db.one('orders',`bale_id=eq.${user}&paid_at=not.is.null&status=in.(paid,review,provisioning)&order=paid_at.desc`);}
async function askName(ctx,bale,user,kind,subscriptionId=null){await state(ctx,user,'first_name',{kind,subscription_id:subscriptionId});await bale.send(user,'نام خود را ارسال کنید.',[['لغو']]);}
async function invoice(ctx,bale,user,data,coupon=null){
 assert(await ctx.ready(),'INTEGRATIONS_REQUIRED',409);
 const order=await ctx.db.rpc('new_order_v2',{p_user:user,p_days:data.days,p_kind:data.kind,p_coupon:coupon,p_subscription:data.subscription_id||null,p_name:data.kind==='renewal'?data.renewal_name:null});
 assert(order&&Number.isFinite(Number(order.total_toman)),'ORDER_CONTRACT',502);
 const lines=[`سفارش ${data.kind==='renewal'?'تمدید':'خرید'} ChatGPT Plus`,`نام: ${order.full_name}`,`مدت: ${money(order.days)} روز`,`مبلغ اولیه: ${money(order.subtotal_toman)} تومان`,`تخفیف: ${money(order.discount_toman)} تومان`,`قابل پرداخت: ${money(order.total_toman)} تومان`,'اعتبار صورتحساب: ۳۰ دقیقه','پس از تأیید پرداخت می‌توانید توکن موجود را ثبت کنید یا توکن جدید بگیرید.'];
 if(Number(order.total_toman)===0){
  // The database has atomically redeemed the coupon; no wallet invoice or fake charge is created.
  assert(order.status==='paid'&&order.paid_at&&order.coupon_id,'FREE_ORDER_NOT_REDEEMED',502);
  if(order.subscription_id){
   try{
    const done=await fulfill(ctx,order.id);
    await state(ctx,user,'menu');
    await deliver(ctx,done);
   }catch(e){
    await ctx.audit('bot.fulfillment_deferred',user,{order_id:order.id,code:e.code||'FULFILLMENT_ERROR'});
    await bale.send(user,`کد تخفیف ۱۰۰٪ اعمال شد و تمدید شما بدون پرداخت ثبت شد ✅\nفعال‌سازی در حال بررسی است. دوباره سفارش ثبت نکنید.\nکد سفارش: ${order.id}`,MENU);
   }
  }else{
   await state(ctx,user,'paid_choice',{order_id:order.id});
   await bale.send(user,`تخفیف کامل اعمال شد ✅\nمبلغ قابل پرداخت: ۰ تومان\nهیچ پرداختی لازم نیست.\n${lines.slice(0,-2).join('\n')}\n\nاکنون نوع دریافت توکن را انتخاب کنید.`,TOKEN);
  }
  return;
 }
 await state(ctx,user,'await_payment',{order_id:order.id});
 try{
  await bale.send(user,lines.join('\n'),[['سفارش‌های من','پشتیبانی'],['منوی اصلی']]);
  const message=await bale.call('sendInvoice',{chat_id:user,title:'اشتراک ChatGPT Plus',description:`${order.days} روز؛ ${order.full_name}`.slice(0,255),payload:order.id,provider_token:await ctx.secret('bale_payment'),prices:[{label:`اشتراک ${order.days} روزه`,amount:Number(order.total_toman)*10}]});
  await ctx.db.patch('orders',`id=eq.${order.id}`,{invoice_message_id:message.message_id});
 }catch(e){await ctx.db.patch('orders',`id=eq.${order.id}&status=eq.pending`,{status:'cancelled',error_code:e.code||'INVOICE_FAILED'});await state(ctx,user,'menu');throw e;}
}
async function receipt(ctx,bale,user,p,transaction=null){
 assert(/^[a-f0-9-]{36}$/.test(p.invoice_payload||''),'PAYMENT_MISMATCH');
 const order=await ctx.db.one('orders',`id=eq.${p.invoice_payload}`);assert(order,'PAYMENT_MISMATCH');
 const tx=transaction||await bale.call('inquireTransaction',{transaction_id:p.telegram_payment_charge_id});verifyPayment(order,p,tx,user);
 const paid=await ctx.db.rpc('record_payment',{p_order:order.id,p_user:user,p_charge:p.telegram_payment_charge_id,p_provider:p.provider_payment_charge_id||'',p_amount:p.total_amount,p_currency:p.currency});
 if(paid.status==='fulfilled')return;
 if(paid.subscription_id){
  try{const done=await fulfill(ctx,paid.id);await state(ctx,user,'menu');await deliver(ctx,done);}catch(e){await ctx.audit('bot.fulfillment_deferred',user,{order_id:paid.id,code:e.code||'FULFILLMENT_ERROR'});await bale.send(user,`پرداخت شما با موفقیت ثبت شد. فعال‌سازی نیازمند بررسی پشتیبانی است؛ دوباره پرداخت نکنید.\nکد سفارش: ${paid.id}`,MENU);}
 }else{await state(ctx,user,'paid_choice',{order_id:paid.id});await bale.send(user,`پرداخت ${money(paid.total_toman)} تومان تأیید شد ✅\nبرای ساخت حساب، «دریافت توکن جدید» را بزنید؛ اگر توکن دارید «ثبت توکن موجود» را انتخاب کنید.`,TOKEN);}
}
export async function reconcilePayment(ctx,order){
 assert(order.pre_checkout_id,'NO_CHECKOUT',409);
 const bale=await ctx.bale(),tx=await bale.call('inquireTransaction',{transaction_id:order.pre_checkout_id});
 assert(tx&&String(tx.id)===order.pre_checkout_id,'PAYMENT_MISMATCH');
 if(tx.status==='paid'){
  await receipt(ctx,bale,order.bale_id,{invoice_payload:order.id,currency:'IRR',total_amount:Number(order.total_toman)*10,telegram_payment_charge_id:order.pre_checkout_id,provider_payment_charge_id:order.provider_charge_id||''},tx);
 }else if(['failed','rejected'].includes(tx.status))await ctx.db.patch('orders',`id=eq.${order.id}&paid_at=is.null&status=eq.checkout`,{status:'cancelled'});
 return{ok:true,payment_status:tx.status};
}
export async function handleMessage(ctx,message){
 assert(message?.chat?.type==='private'&&message.from?.id===message.chat.id,'PRIVATE_CHAT_ONLY');
 const user=message.from.id,bale=await ctx.bale();
 await ctx.db.upsert('customers',{bale_id:user},'bale_id');
 if(message.successful_payment)return receipt(ctx,bale,user,message.successful_payment);
 let text=String(message.text||'').trim();if(!text)return;
 await ctx.rate(`bot-user:${user}`,40,60);
 let convo=await ctx.db.one('conversations',`bale_id=eq.${user}`)||{state:'menu',data:{}};
 if(Date.now()-Date.parse(convo.updated_at||0)>86400000&&!['paid_choice','paid_token'].includes(convo.state))convo={state:'menu',data:{}};
 const data=convo.data||{};
 try{
  if(text==='/start'||text==='آموزش و دانلود'){
   await state(ctx,user,'os');return bale.send(user,'به جی‌پی‌تی‌یار خوش آمدید ✨\nبرای دریافت آموزش و لینک دانلود، سیستم‌عامل خود را انتخاب کنید.',OS);
  }
  if(['لغو','/cancel','منوی اصلی'].includes(text)){
   // Leaving a paid flow never discards the paid order; it remains available under registration.
   if(data.order_id)await ctx.db.patch('orders',`id=eq.${data.order_id}&bale_id=eq.${user}&status=eq.pending`,{status:'cancelled'});
   await state(ctx,user,'menu');return bale.send(user,'از منوی زیر انتخاب کنید.',MENU);
  }
  if(text==='پشتیبانی'||text==='/support'){
   const s=await ctx.settings();return bale.send(user,`برای پشتیبانی در ایتا یا چت آگهی دیوار پیام بدهید:\n\nایتا:\n${s.support_eitaa}\n\nدیوار:\n${s.support_divar}\n\nدر صورت داشتن سفارش، کد آن را برای پشتیبانی ارسال کنید.`,MENU);
  }
  if(text==='سفارش‌های من'){
   const rows=await ctx.db.list('orders',`bale_id=eq.${user}&select=id,status,total_toman,days,created_at&order=created_at.desc&limit=5`);
   return bale.send(user,rows.length?rows.map(o=>`${LABELS[o.status]} | ${money(o.days)} روز | ${money(o.total_toman)} تومان\n${o.id}`).join('\n\n'):'هنوز سفارشی ثبت نکرده‌اید.',MENU);
  }
  if(text==='خرید اشتراک'){
   const s=await ctx.settings();assert(s.sales_enabled,'SALES_DISABLED');return askName(ctx,bale,user,'purchase');
  }
  if(text==='تمدید با توکن'){
   const s=await ctx.settings();assert(s.sales_enabled,'SALES_DISABLED');await state(ctx,user,'renewal_token');return bale.send(user,'توکن کاربری فعلی خود را ارسال کنید. اعتبار باقی‌مانده شما حفظ می‌شود و روزهای جدید به آن اضافه خواهد شد.',[['لغو']]);
  }
  if(text==='ثبت توکن پس از پرداخت'){
   const paid=await paidOrder(ctx,user);assert(paid,'NO_PAID_ORDER');
   if(paid.subscription_id){try{await deliver(ctx,await fulfill(ctx,paid.id));return;}catch{return bale.send(user,`پرداخت ثبت شده و سفارش در حال بررسی است. دوباره پرداخت نکنید.\n${paid.id}`,MENU);}}
   await state(ctx,user,'paid_choice',{order_id:paid.id});return bale.send(user,'برای این سفارش توکن جدید می‌خواهید یا توکن موجود را ثبت می‌کنید؟',TOKEN);
  }
  if(convo.state==='os'){
   const os={'اندروید':'android','آیفون':'ios','ویندوز':'windows','مک':'mac'}[text];if(!os)return bale.send(user,'یکی از چهار سیستم‌عامل را انتخاب کنید.',OS);
   const link=await ctx.db.one('links',`os=eq.${os}`);await ctx.db.patch('customers',`bale_id=eq.${user}`,{os});await state(ctx,user,'buy_choice');
   await bale.send(user,`آموزش ${link.title}:\n${link.tutorial_url}\n\nدانلود اکستنشن:\n${link.download_url}\n\nتوجه: پس از دانلود، اکستنشن را حذف نکنید و به پوشه دیگری منتقل نکنید.${link.note?'\n\n'+link.note:''}`);
   return bale.send(user,'آیا مایل به خرید اکانت ChatGPT Plus هستید؟',YESNO);
  }
  if(convo.state==='buy_choice'){
   if(text==='بله'){const s=await ctx.settings();assert(s.sales_enabled,'SALES_DISABLED');return askName(ctx,bale,user,'purchase');}
   if(text==='خیر'){await state(ctx,user,'menu');return bale.send(user,'هر زمان نیاز داشتید، خرید و تمدید از همین منو در دسترس است.',MENU);}
   return bale.send(user,'لطفاً «بله» یا «خیر» را انتخاب کنید.',YESNO);
  }
  if(convo.state==='renewal_token'){
   const sub=await attachToken(ctx,user,text);await state(ctx,user,'days',{kind:'renewal',subscription_id:sub.id,renewal_name:sub.remote_name});const settings=await ctx.settings();return bale.send(user,`اشتراک متعلق به «${sub.remote_name}» شناسایی شد.\nبرای تمدید چند روز می‌خواهید؟\nهر روز ${money(settings.daily_price_toman)} تومان؛ از ۱ تا ${money(settings.max_days)} روز.`,[['۷','۱۵','۳۰'],['لغو']]);
  }
  if(convo.state==='first_name'){
   const first=name(text);await ctx.db.patch('customers',`bale_id=eq.${user}`,{first_name:first});await state(ctx,user,'last_name',data);return bale.send(user,'نام خانوادگی خود را ارسال کنید.',[['لغو']]);
  }
  if(convo.state==='last_name'){
   await ctx.db.patch('customers',`bale_id=eq.${user}`,{last_name:name(text)});await state(ctx,user,'days',data);const s=await ctx.settings();return bale.send(user,`اشتراک را برای چند روز می‌خواهید؟\nهر روز ${money(s.daily_price_toman)} تومان؛ از ۱ تا ${money(s.max_days)} روز.`,[['۷','۱۵','۳۰'],['لغو']]);
  }
  if(convo.state==='days'){
   const s=await ctx.settings(),days=integer(text,1,s.max_days);await state(ctx,user,'coupon_choice',{...data,days});return bale.send(user,'آیا کد تخفیف دارید؟',YESNO);
  }
  if(convo.state==='coupon_choice'){
   if(text==='بله'){await state(ctx,user,'coupon_code',data);return bale.send(user,'کد تخفیف را ارسال کنید.',[['بدون تخفیف'],['لغو']]);}
   if(text==='خیر')return await invoice(ctx,bale,user,data);
   return bale.send(user,'لطفاً «بله» یا «خیر» را انتخاب کنید.',YESNO);
  }
  if(convo.state==='coupon_code')return await invoice(ctx,bale,user,data,text==='بدون تخفیف'?null:text);
  if(convo.state==='paid_choice'||convo.state==='paid_token'){
   const order=await ctx.db.one('orders',`id=eq.${data.order_id}&bale_id=eq.${user}`);assert(order?.paid_at,'PAYMENT_REQUIRED');
   if(order.status==='fulfilled'){await deliver(ctx,order);await state(ctx,user,'menu');return;}
   if(text==='ثبت توکن موجود'){await state(ctx,user,'paid_token',data);return bale.send(user,'توکن کاربری موجود خود را ارسال کنید تا روزهای خریداری‌شده به اعتبار آن اضافه شود.',[['لغو']]);}
   if(text!=='دریافت توکن جدید'){
    if(convo.state!=='paid_token')return bale.send(user,'یکی از گزینه‌های زیر را انتخاب کنید.',TOKEN);
    const sub=await attachToken(ctx,user,text);await ctx.db.patch('orders',`id=eq.${order.id}&bale_id=eq.${user}&status=eq.paid`,{subscription_id:sub.id,kind:'renewal',full_name:sub.remote_name});
   }
   try{const done=await fulfill(ctx,order.id);await state(ctx,user,'menu');await deliver(ctx,done);}catch(e){await bale.send(user,`پرداخت شما ثبت شده است؛ فعال‌سازی برای بررسی به پشتیبانی ارجاع شد. دوباره پرداخت نکنید.\nکد سفارش: ${order.id}`,MENU);await ctx.audit('bot.fulfillment_deferred',user,{order_id:order.id,code:e.code||'FULFILLMENT_ERROR'});}
   return;
  }
  if(convo.state==='await_payment')return bale.send(user,'ابتدا صورتحساب ارسال‌شده را پرداخت کنید. ثبت توکن فقط پس از تأیید پرداخت فعال می‌شود.',[['سفارش‌های من','پشتیبانی'],['منوی اصلی']]);
  return bale.send(user,'برای دریافت آموزش /start را بفرستید یا از منوی زیر انتخاب کنید.',MENU);
 }catch(e){
  if(ERRORS[e.code])return bale.send(user,ERRORS[e.code],['coupon_choice','coupon_code'].includes(convo.state)?[['بدون تخفیف'],['لغو']]:[['منوی اصلی','پشتیبانی']]);
  throw e;
 }
}
