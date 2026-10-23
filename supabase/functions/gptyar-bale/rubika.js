import {AppError,assert} from './domain.js';

// Official Rubika Bot API v3: https://rubika.ir/botapi
// Intentionally separate from Bale's numeric user IDs, invoices and webhook.
const BASE='https://botapi.rubika.ir/v3/';
const LABELS=[
 '/start','خرید اشتراک','تمدید با توکن','ثبت توکن پس از پرداخت','دریافت مجدد توکن',
 'دریافت صورتحساب','سفارش‌های من','آموزش و دانلود','پشتیبانی','اندروید','آیفون',
 'ویندوز','مک','بله','خیر','لغو','منوی اصلی','دریافت توکن جدید','ثبت توکن موجود',
 'بدون تخفیف','۷','۱۵','۳۰'
];
// Stable IDs decouple the chat keypad transport from user-visible Persian labels.
const CODE=new Map(LABELS.map((label,i)=>['gpy_'+(i+1),label]));
const REVERSE=new Map([...CODE].map(([id,label])=>[label,id]));
export function rubikaKeyboard(rows){
 assert(Array.isArray(rows)&&rows.every(row=>Array.isArray(row)),'RUBIKA_KEYBOARD',500);
 return {rows:rows.map(row=>({buttons:row.map(label=>{
  assert(REVERSE.has(label),'RUBIKA_KEYBOARD',500);
  return {id:REVERSE.get(label),type:'Simple',button_text:label};
 })})),resize_keyboard:true,one_time_keyboard:false};
}

// Only accept private, unedited user messages. Neither a pasted receipt nor
// a button press grants payment status. Numeric Bale and string Rubika identities
// must NEVER share the same namespace.
export function normalizeRubikaUpdate(body){
 const update=body?.update;
 const message=update?.type==='NewMessage'?update.new_message:body?.inline_message;
 const chatId=String(update?.chat_id??message?.chat_id??'');
 const sender=String(message?.sender_id??'');
 if(!message||message.is_edited===true||message.sender_type&&message.sender_type!=='User')return null;
 if(!/^u[A-Za-z0-9]{4,80}$/.test(sender)||chatId!==sender)return null;
 const id=String(message.message_id??'');
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))return null;
 const buttonId=message.aux_data?.button_id;
 const mapped=typeof buttonId==='string'?CODE.get(buttonId):undefined;
 if(buttonId!=null&&!mapped)return null;
 const text=mapped||String(message.text||'').trim();
 if(!text||text.length>4096)return null;
 return {channel:'rubika',userId:sender,chatId,messageId:id,text,
  eventId:`rubika:${chatId}:${id}`};
}
export class Rubika {
 constructor(token,transport=fetch){
  assert(typeof token==='string'&&token.length>=10&&token.length<=512&&!/\s/.test(token)&&!['/','?','#','\\'].some(ch=>token.includes(ch)),'INVALID_RUBIKA_TOKEN');
  this.token=token;
  this.transport=transport;
 }
 async call(method,body={}){
  assert(/^[a-zA-Z]+$/.test(method),'RUBIKA_METHOD',500);
  let response;
  try{
   response=await this.transport(`${BASE}${this.token}/${method}`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(8000)
   });
  }catch{throw new AppError('RUBIKA_UNREACHABLE',502);}
  const json=await response.json().catch(()=>null);
  if(!response.ok||!json||json.status&&String(json.status).toUpperCase()!=='OK'||json.ok===false)
   throw new AppError('RUBIKA_API_ERROR',502);
  return json.data??json.result??json;
 }
 async send(chatId,text,keyboard){
  assert(typeof chatId==='string'&&/^u[A-Za-z0-9]{4,80}$/.test(chatId),'RUBIKA_CHAT',400);
  assert(typeof text==='string'&&text.length>0&&text.length<=4096,'RUBIKA_MESSAGE',400);
  return this.call('sendMessage',{
   chat_id:chatId,text,
   ...(keyboard?{chat_keypad_type:'New',chat_keypad:rubikaKeyboard(keyboard)}:
    {chat_keypad_type:'Remove'})
  });
 }
}
