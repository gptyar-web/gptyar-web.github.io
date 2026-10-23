import {AppError,assert,normalizeSubscriber} from './domain.js';
export class Database {
 constructor(env,transport=fetch){this.env=env;this.transport=transport;}
 async request(path,method='GET',body,prefer='return=representation'){
  assert(/^(?:rpc\/)?gpyb_[a-z][a-z0-9_]*(?:\?[^#]*)?$/.test(path),'DATABASE_RESOURCE',500);
  let r;try{r=await this.transport(`${this.env.SUPABASE_URL}/rest/v1/${path}`,{method,headers:{apikey:this.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json',Prefer:prefer},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});}catch{throw new AppError('DATABASE_UNREACHABLE',503);}
  const d=await r.json().catch(()=>null);if(!r.ok){const code=d?.message?.match(/^[A-Z_]+$/)?.[0]||(d?.code==='23505'?'ALREADY_EXISTS':'DATABASE_ERROR');const status=/OTP|CHALLENGE|AUTH_DENIED/.test(code)?401:code==='SETUP_DENIED'?403:r.status===409?409:code!=='DATABASE_ERROR'?400:503;throw new AppError(code,status);}return d;
 }
 async rpc(name,args={}){const result=await this.request(`rpc/gpyb_${name}`,'POST',args);return ['new_order','new_order_v2','checkout_order','bind_token','record_payment','complete','select_subscription','rubika_bridge_claim','rubika_bridge_record'].includes(name)&&Array.isArray(result)?result[0]:result;}
 async one(table,q=''){return(await this.request(`gpyb_${table}?${q}${q?'&':''}limit=1`))[0]||null;}
 list(table,q=''){return this.request(`gpyb_${table}?${q}`);}
 insert(table,body){return this.request(`gpyb_${table}`,'POST',body);}
 upsert(table,body,on){return this.request(`gpyb_${table}?on_conflict=${on}`,'POST',body,'resolution=merge-duplicates,return=representation');}
 patch(table,q,body){return this.request(`gpyb_${table}?${q}`,'PATCH',body);}
 delete(table,q){return this.request(`gpyb_${table}?${q}`,'DELETE');}
}
export class Bale {
 constructor(token,transport=fetch){this.token=token;this.transport=transport;}
 async call(method,body={}){let r;try{r=await this.transport(`https://tapi.bale.ai/bot${this.token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(7000)});}catch{throw new AppError('BALE_UNREACHABLE',502);}const d=await r.json().catch(()=>null);if(!r.ok||d?.ok!==true){const e=new AppError('BALE_API_ERROR',502);e.definiteRejection=r.status>=400&&r.status<500||r.ok&&d?.ok===false;throw e;}return d.result;}
 send(id,text,keyboard){return this.call('sendMessage',{chat_id:id,text,...(keyboard?{reply_markup:{keyboard:keyboard.map(row=>row.map(text=>({text}))),resize_keyboard:true}}:{reply_markup:{remove_keyboard:true}})});}
}
// Adapter verified against extension v4.6.5: POST validate with token/version, GET subscribers/all with Bearer, POST create and PATCH update.
// A successful administrator validation and subscriber listing are required before enabling sales.
export class Extension {
 constructor(token,version='4.6.5',transport=fetch){this.token=token;this.version=version;this.transport=transport;}
 async call(path,method='GET',body){
  let r;
  try{
   r=await this.transport(`https://api.gptyar.com/accupdator/${path}`,{
    method,headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json',Accept:'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(12000)
   });
  }catch{throw new AppError('EXTENSION_UNREACHABLE',502);}
  const d=await r.json().catch(()=>null);
  const upstreamCode=[d?.code,d?.error?.code,d?.error].find(x=>['ENTERPRISE_EXPIRY_LIMIT','ENTERPRISE_USER_LIMIT'].includes(x));
  const businessCode=upstreamCode==='ENTERPRISE_EXPIRY_LIMIT'?'EXTENSION_EXPIRY_LIMIT':upstreamCode==='ENTERPRISE_USER_LIMIT'?'EXTENSION_USER_LIMIT':null;
  if(!r.ok){
   const e=new AppError(businessCode||(r.status===401||r.status===403?'EXTENSION_UNAUTHORIZED':'EXTENSION_API_ERROR'),502);
   e.definiteRejection=r.status>=400&&r.status<500;
   throw e;
  }
  assert(d&&typeof d==='object'&&!Array.isArray(d),'EXTENSION_CONTRACT',502);
  // Some upstream endpoints report application-level errors with HTTP 200.
  // Never mislabel an explicit rejection as a malformed response.
  if(d.error||businessCode){const e=new AppError(businessCode||'EXTENSION_REJECTED',502);e.definiteRejection=true;throw e;}
  return d;
 }
 async list({normalize=true}={}){
  const d=await this.call('subscribers/all');
  assert(d.accountId!==undefined&&d.accountId!==null&&String(d.accountId).trim()!==''&&Array.isArray(d.subscribers),'EXTENSION_LIST_FORMAT',502);
  // Manager validation checks account ownership and ability to read the list.
  // It must not fail because of a legacy or incomplete *individual subscriber*.
  const subscribers=normalize?d.subscribers.flatMap(s=>{try{return[normalizeSubscriber(s)];}catch{return[];}}):d.subscribers;
  return{accountId:String(d.accountId),subscribers,count:d.subscribers.length,accountType:d.accountType,limits:d.limits};
 }
 async validate(){
  assert(typeof this.token==='string'&&/^@[^\s\u0000-\u001f\u007f]{1,511}$/.test(this.token),'INVALID_ADMIN_TOKEN');
  const p=await this.call('validate','POST',{token:this.token,version:this.version});
  assert(p.account&&p.account.id!==undefined&&p.account.id!==null&&String(p.account.id).trim()!=='','EXTENSION_VALIDATE_FORMAT',502);
  const listing=await this.list({normalize:false});
  assert(listing.accountId===String(p.account.id),'EXTENSION_SCOPE',403);
  return{accountId:listing.accountId,count:listing.subscribers.length};
 }
 create(fullName,expiresAt){return this.call('subscribers/create','POST',{name:fullName,expiresAt});}
 update(remoteId,expiresAt){return this.call('subscribers/update','PATCH',{subscriptionId:remoteId,expiresAt});}
}
