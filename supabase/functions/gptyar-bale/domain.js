export class AppError extends Error {constructor(code,status=400){super(code);this.code=code;this.status=status;}}
export const assert=(ok,code,status=400)=>{if(!ok)throw new AppError(code,status);};
export const digits=v=>String(v??'').replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).trim();
export function integer(v,min=1,max=3650){const s=digits(v);assert(/^\d+$/.test(s),'INVALID_NUMBER');const n=Number(s);assert(Number.isSafeInteger(n)&&n>=min&&n<=max,'INVALID_NUMBER');return n;}
export function expiry(base,days,now=Date.now()){return new Date(Math.max(Date.parse(base)||0,now)+integer(days)*86400000).toISOString();}
export function url(value){let u;try{u=new URL(String(value));}catch{throw new AppError('INVALID_URL');}assert(u.protocol==='https:'&&!u.username&&!u.password&&u.href.length<1000,'INVALID_URL');return u.href;}
export function name(value){const s=String(value||'').trim().replace(/\s+/g,' ');assert(s.length>=2&&s.length<=60&&!/[\u0000-\u001f<>]/.test(s),'INVALID_NAME');return s;}
// The upstream extension may return numeric IDs and omit tokens for old/disabled records.
// A missing personal token is never interpreted as valid for activation or delivery.
export function normalizeSubscriber(s){
 assert(s&&typeof s==='object'&&!Array.isArray(s),'EXTENSION_SUBSCRIBER_FORMAT',502);
 const id=s.subscriptionId;
 assert((typeof id==='string'&&id.trim()!=='')||(typeof id==='number'&&Number.isSafeInteger(id)),'EXTENSION_SUBSCRIBER_FORMAT',502);
 const token=typeof s.token==='string'&&s.token.length>0&&!s.token.startsWith('@')?s.token:null;
 assert(s.expiresAt==null||(typeof s.expiresAt==='string'&&Number.isFinite(Date.parse(s.expiresAt))),'EXTENSION_SUBSCRIBER_FORMAT',502);
 return {remote_id:String(id),token,name:String(s.name||''),expires_at:s.expiresAt||null};
}
export function verifyPayment(order,payment,tx,user){assert(String(order.bale_id)===String(user)&&payment.currency==='IRR'&&Number(payment.total_amount)===Number(order.total_toman)*10,'PAYMENT_MISMATCH');assert(tx?.status==='paid'&&String(tx.id)===String(payment.telegram_payment_charge_id)&&String(tx.userID)===String(user)&&Number(tx.amount)===Number(payment.total_amount),'PAYMENT_NOT_VERIFIED');if(order.pre_checkout_id)assert(order.pre_checkout_id===payment.telegram_payment_charge_id,'PAYMENT_MISMATCH');}
export const LABELS={pending:'در انتظار پرداخت',checkout:'در حال پرداخت',paid:'پرداخت‌شده',provisioning:'در حال فعال‌سازی',fulfilled:'تکمیل‌شده',review:'نیازمند بررسی',cancelled:'لغوشده',expired:'منقضی‌شده'};
