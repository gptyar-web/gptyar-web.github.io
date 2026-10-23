import {assert} from './domain.js';

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
 assert(binding.state==='claimed'&&String(binding.bale_user_id)===String(payerId),'PAYMENT_MISMATCH',409);
 assert(String(success.invoice_payload)===order.id,'PAYMENT_MISMATCH',409);
 assert(success.currency==='IRR'&&Number(success.total_amount)===Number(order.total_toman)*10
   &&Number(order.total_toman)>0,'PAYMENT_MISMATCH',409);
 const charge=String(success.telegram_payment_charge_id||'');
 assert(charge.length>0&&charge.length<=128&&charge===String(transaction.id),'PAYMENT_MISMATCH',409);
 assert(transaction.status==='paid'&&String(transaction.userID)===String(payerId)
   &&Number(transaction.amount)===Number(success.total_amount),'PAYMENT_NOT_VERIFIED',409);
 return {orderId:order.id,chargeId:charge,payerId:String(payerId),amount:Number(success.total_amount)};
}
