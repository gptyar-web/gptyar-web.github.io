import {assert} from './domain.js';
import {random,hash} from './crypto.js';
import {rubikaView} from './rubika-context.js';

// This opens the existing Bale bot. It is NOT a public bank payment URL.
// The bot must recognize /start rb_<nonce> and offer a wallet invoice
// ONLY for the server-side Rubika order bound to that nonce.
export function baleBridgeLink(username,nonce){
 assert(typeof username==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{3,64}$/.test(username),'BRIDGE_BOT_USERNAME');
 assert(typeof nonce==='string'&&/^[a-f0-9]{48,128}$/.test(nonce),'BRIDGE_NONCE');
 return `https://ble.ir/${username}?start=rb_${nonce}`;
}
// Never authorize fulfillment using a public link, screenshot, callback button,
// client-supplied status, or a miniapp-only invoice identifier.
// The stored binding is a one-time server-side record of the Rubika order
// and the real Bale account that opened the link.
export function verifyBaleBridgePayment({order,binding,success,transaction,payerId}){
 assert(order&&binding&&success&&transaction,'PAYMENT_MISMATCH',409);
 assert(typeof order.id==='string'&&order.id===binding.order_id,'PAYMENT_MISMATCH',409);
 assert(['claimed','paid'].includes(binding.state)&&String(binding.bale_user_id)===String(payerId),'PAYMENT_MISMATCH',409);
 if(binding.state==='paid')assert(order.charge_id===success.telegram_payment_charge_id&&order.paid_at,'PAYMENT_MISMATCH',409);
 assert(String(success.invoice_payload)===order.id,'PAYMENT_MISMATCH',409);
 assert(success.currency==='IRR'&&Number(success.total_amount)===Number(order.total_toman)*10
   &&Number(order.total_toman)>0,'PAYMENT_MISMATCH',409);
 const charge=String(success.telegram_payment_charge_id||'');
 assert(charge.length>0&&charge.length<=128&&charge===String(transaction.id),'PAYMENT_MISMATCH',409);
 assert(transaction.status==='paid'&&String(transaction.userID)===String(payerId)
   &&Number(transaction.amount)===Number(success.total_amount),'PAYMENT_NOT_VERIFIED',409);
 return {orderId:order.id,chargeId:charge,payerId:String(payerId),amount:Number(success.total_amount)};
}

export async function issueRubikaBaleLink(ctx,order){
 assert(ctx.platform==='rubika'&&Number(order.bale_id)<0,'BRIDGE_NOT_RUBIKA',409);
 const settings=await ctx.settings();
 const nonce=random();
 await ctx.db.rpc('rubika_bridge_issue',{p_order:order.id,p_virtual:order.bale_id,p_hash:await hash(nonce)});
 return baleBridgeLink(settings.bot_username,nonce);
}

// Only a verified Bale user can claim a pending, unexpired Rubika order.
export async function startBaleBridge(ctx,message){
 const from=message?.from?.id,chat=message?.chat?.id;
 assert(message.chat?.type==='private'&&Number.isSafeInteger(from)&&from>0&&chat===from,'PRIVATE_CHAT_ONLY');
 const match=String(message.text||'').trim().match(/^\/start rb_([a-f0-9]{64})$/);
 if(!match)return false;
 const order=await ctx.db.rpc('rubika_bridge_claim',{p_hash:await hash(match[1]),p_bale:from});
 assert(order&&Number(order.total_toman)>0,'BRIDGE_NOT_PAYABLE',409);
 const bale=await ctx.bale();
 await bale.send(from,
  `صورتحساب سفارش روبیکا آماده است. ✅\nنام: ${order.full_name}\nمدت: ${order.days} روز\nمبلغ: ${Number(order.total_toman).toLocaleString('fa-IR')} تومان\n\nپس از پرداخت، نتیجه در روبیکا ارسال می‌شود. برای دریافت نتیجه، به روبیکا برگردید.`);
 const invoice=await bale.call('sendInvoice',{
  chat_id:from,title:'تمدید یا خرید اشتراک جی‌پی‌تی‌یار',
  description:`${order.days} روز؛ ${order.full_name}`.slice(0,255),
  payload:order.id,
  provider_token:await ctx.secret('bale_payment'),
  prices:[{label:`اشتراک ${order.days} روزه`,amount:Number(order.total_toman)*10}]
 });
 if(invoice?.message_id)await ctx.db.patch('orders',`id=eq.${order.id}`,{invoice_message_id:invoice.message_id});
 return true;
}

export async function rubikaBridgeReceipt(ctx,message,completePaidOrder){
 const payment=message?.successful_payment,payer=message?.from?.id;
 if(!payment||!Number.isSafeInteger(payer)||payer<1)return false;
 const id=String(payment.invoice_payload||'');
 if(!/^[a-f0-9-]{36}$/.test(id))return false;
 const binding=await ctx.db.one('rubika_bridges',`order_id=eq.${id}`);
 if(!binding)return false;
 const order=await ctx.db.one('orders',`id=eq.${id}`);
 const bale=await ctx.bale();
 const transaction=await bale.call('inquireTransaction',{transaction_id:payment.telegram_payment_charge_id});
 verifyBaleBridgePayment({order,binding,success:payment,transaction,payerId:payer});
 const paid=await ctx.db.rpc('rubika_bridge_record',{
  p_order:id,p_bale:payer,p_charge:payment.telegram_payment_charge_id,
  p_provider:payment.provider_payment_charge_id||'',
  p_amount:payment.total_amount,p_currency:payment.currency
 });
 // The Rubika sender is resolved from the negative virtual customer ID.
 // A failed message delivery leaves the order paid and retriable.
 const view=await rubikaView(ctx);
 await completePaidOrder(view,paid);
 return true;
}
