import test from 'node:test';
import assert from 'node:assert/strict';
import {handleMessage,reconcilePayment} from '../supabase/functions/gptyar-bale/bot.js';
import {AppError} from '../supabase/functions/gptyar-bale/domain.js';
function fixture({free=false}={}){
 const customers=new Map(),conversations=new Map(),messages=[],invoices=[],orders=[],settings={sales_enabled:true,daily_price_toman:35000,max_days:365,extension_account_id:'account1'},links={android:'yzu9013',ios:'osy001n',windows:'raf7344',mac:'raf7344'};
 const bale={send:async(user,text,keyboard)=>{messages.push({text,keyboard});return{message_id:1};},call:async(method,body)=>{assert.equal(method,'sendInvoice');invoices.push(body);return{message_id:2};}};
 const upstream=[{remote_id:'r1',token:'existing-user-token',name:'زهرا مرادی [GY:1b2b7e78-6ab8-47e6-bf25-d6487e2e3377]',expires_at:'2026-12-01T00:00:00Z'}];
 const ctx={settings:async()=>settings,rate:async()=>{},ready:async()=>true,bale:async()=>bale,secret:async()=> 'wallet-test-placeholder',
 extension:async()=>({list:async()=>({accountId:'account1',subscribers:upstream})}),
 encrypt:async()=>'<cipher>',db:{
  upsert:async(table,row)=>{const m=table==='customers'?customers:conversations;m.set(row.bale_id,{...m.get(row.bale_id),...row});},
  one:async(table,q)=>{if(table==='links'){const os=q.split('eq.')[1];return{title:os,tutorial_url:'https://www.aparat.com/v/'+links[os],download_url:'https://gptyar2.soservice.ir/download',note:''};}if(table==='conversations')return conversations.get(123);if(table==='subscriptions')return{id:'local-sub-1',remote_id:'r1'};if(table==='orders')return orders.find(x=>q.includes('eq.'+x.id))||null;},
  patch:async(table,q,row)=>{if(table==='customers')customers.set(123,{...customers.get(123),...row});},
  list:async()=>[],
  rpc:async(method,p)=>{
   if(method==='bind_token')return{id:'local-sub-1'};
   assert.equal(method,'checkout_order');
   if(p.p_coupon==='BAD')throw new AppError('INVALID_COUPON');
   const subtotal=p.p_days*35000,discount=free&&p.p_coupon==='FREE100'?subtotal:0;
   const o={bale_id:123,expires_at:new Date(Date.now()+1800000).toISOString(),id:'1b2b7e78-6ab8-47e6-bf25-d6487e2e3377',full_name:p.p_kind==='renewal'?p.p_name:customers.get(123).first_name+' '+customers.get(123).last_name,
   kind:p.p_kind,subscription_id:p.p_subscription,days:p.p_days,subtotal_toman:subtotal,discount_toman:discount,total_toman:subtotal-discount,
   coupon_id:discount?'coupon1':null,status:discount?'paid':'pending',paid_at:discount?new Date().toISOString():null};orders.push(o);return o;
  }
 }};
 const send=text=>handleMessage(ctx,{chat:{id:123,type:'private'},from:{id:123},text});
 return{ctx,send,customers,conversations,messages,invoices,orders};
}
test('onboarding sends the selected tutorial and download warning before offering purchase',async()=>{
 const f=fixture();await f.send('/start');assert.deepEqual(f.messages[0].keyboard,[['اندروید','آیفون'],['ویندوز','مک']]);await f.send('آیفون');
 assert.match(f.messages[1].text,/osy001n/);assert.match(f.messages[1].text,/حذف نکنید/);assert.match(f.messages[1].text,/gptyar2/);assert.match(f.messages[2].text,/خرید/);
});
test('purchase collects name and days, asks discount, then invoices at 35000 tomans per day',async()=>{
 const f=fixture();for(const x of ['/start','اندروید','بله','محمد','احمدی','۷','خیر'])await f.send(x);
 assert.equal(f.customers.get(123).first_name,'محمد');assert.equal(f.invoices.length,1);assert.equal(f.invoices[0].prices[0].amount,2450000);assert.equal(f.conversations.get(123).state,'await_payment');
 await f.send('a-user-token');assert.match(f.messages.at(-1).text,/پس از تأیید پرداخت/);
});
test('an invalid coupon stays retryable and can be skipped without losing the order details',async()=>{
 const f=fixture();for(const x of ['خرید اشتراک','محمد','احمدی','7','بله','BAD'])await f.send(x);
 assert.equal(f.conversations.get(123).state,'coupon_code');assert.equal(f.invoices.length,0);assert.match(f.messages.at(-1).text,/نامعتبر/);
 await f.send('بدون تخفیف');assert.equal(f.invoices.length,1);
});
test('post-payment token registration is unavailable without a paid order',async()=>{
 const f=fixture();await f.send('ثبت توکن پس از پرداخت');assert.match(f.messages.at(-1).text,/ابتدا خرید و پرداخت/);
});
test('payment reconciliation releases a failed checkout but never treats pending as paid',async()=>{
 let status='pending',patched=0;
 const ctx={bale:async()=>({call:async()=>({id:'charge1',status})}),db:{patch:async()=>{patched++;}}};
 const order={id:'test-order',pre_checkout_id:'charge1'};
 assert.equal((await reconcilePayment(ctx,order)).payment_status,'pending');assert.equal(patched,0);
 status='failed';assert.equal((await reconcilePayment(ctx,order)).payment_status,'failed');assert.equal(patched,1);
});

test('100-percent coupon produces a zero-toman order without attempting any wallet invoice',async()=>{
 const f=fixture({free:true});
 for(const step of ['خرید اشتراک','زهرا','مرادی','۷','بله','FREE100'])await f.send(step);
 assert.equal(f.invoices.length,0);
 assert.equal(f.orders.length,1);
 assert.equal(f.orders[0].total_toman,0);
 assert.equal(f.orders[0].status,'paid');
 assert.ok(f.orders[0].paid_at);
 assert.equal(f.conversations.get(123).state,'paid_choice');
 assert.match(f.messages.at(-1).text,/هیچ پرداختی لازم نیست/);
});
test('renewal uses the saved upstream subscriber name without asking for either name field',async()=>{
 const f=fixture();
 await f.send('تمدید با توکن');await f.send('existing-user-token');
 assert.equal(f.conversations.get(123).state,'days');
 assert.equal(f.conversations.get(123).data.renewal_name,'زهرا مرادی');
 assert.match(f.messages.at(-1).text,/زهرا مرادی/);
 assert.doesNotMatch(f.messages.at(-1).text,/نام خانوادگی خود را ارسال کنید/);
 await f.send('۷');await f.send('خیر');
 assert.equal(f.invoices.length,1);
 assert.equal(f.orders[0].full_name,'زهرا مرادی');
 assert.equal(f.orders[0].kind,'renewal');
});
