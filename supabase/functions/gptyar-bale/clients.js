import {AppError,assert,normalizeSubscriber} from './domain.js';
export class Database {
 constructor(env,transport=fetch){this.env=env;this.transport=transport;}
 async request(path,method='GET',body,prefer='return=representation'){
  assert(/^(gpyb_[a-z_]+|rpc\/gpyb_[a-z_]+)(\?|$)/.test(path),'DATABASE_RESOURCE',500);
  let r;try{r=await this.transport(`${this.env.SUPABASE_URL}/rest/v1/${path}`,{method,headers:{apikey:this.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json',Prefer:prefer},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});}catch{throw new AppError('DATABASE_UNREACHABLE',503);}
  const d=await r.json().catch(()=>null);if(!r.ok){const code=d?.message?.match(/^[A-Z_]+$/)?.[0]||'DATABASE_ERROR';const status=/OTP|CHALLENGE|AUTH_DENIED/.test(code)?401:code==='SETUP_DENIED'?403:r.status===409?409:code!=='DATABASE_ERROR'?400:503;throw new AppError(code,status);}return d;
 }
 async rpc(name,args={}){const result=await this.request(`rpc/gpyb_${name}`,'POST',args);return ['new_order','bind_token','record_payment','complete'].includes(name)&&Array.isArray(result)?result[0]:result;}
 async one(table,q=''){return(await this.request(`gpyb_${table}?${q}${q?'&':''}limit=1`))[0]||null;}
 list(table,q=''){return this.request(`gpyb_${table}?${q}`);}
 insert(table,body){return this.request(`gpyb_${table}`,'POST',body);}
 upsert(table,body,on){return this.request(`gpyb_${table}?on_conflict=${on}`,'POST',body,'resolution=merge-duplicates,return=representation');}
 patch(table,q,body){return this.request(`gpyb_${table}?${q}`,'PATCH',body);}
 delete(table,q){return this.request(`gpyb_${table}?${q}`,'DELETE');}
}
export class Bale {
 constructor(token,transport=fetch){this.token=token;this.transport=transport;}
 async call(method,body={}){let r;try{r=await this.transport(`https://tapi.bale.ai/bot${this.token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(7000)});}catch{throw new AppError('BALE_UNREACHABLE',502);}const d=await r.json().catch(()=>null);assert(r.ok&&d?.ok===true,'BALE_API_ERROR',502);return d.result;}
 send(id,text,keyboard){return this.call('sendMessage',{chat_id:id,text,...(keyboard?{reply_markup:{keyboard:keyboard.map(row=>row.map(text=>({text}))),resize_keyboard:true}}:{reply_markup:{remove_keyboard:true}})});}
}
// Adapter recovered from the user's existing gptyar-api source (extension 4.6.5).
// A successful administrator validation and subscriber listing are required before enabling sales.
export class Extension {
 constructor(token,version='4.6.5',transport=fetch){this.token=token;this.version=version;this.transport=transport;}
 async call(path,method='GET',body){let r;try{r=await this.transport(`https://api.gptyar.com/accupdator/${path}`,{method,headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json',Accept:'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(12000)});}catch{throw new AppError('EXTENSION_UNREACHABLE',502);}const d=await r.json().catch(()=>null);if(!r.ok){const e=new AppError(r.status===401||r.status===403?'EXTENSION_UNAUTHORIZED':'EXTENSION_API_ERROR',502);e.definiteRejection=r.status>=400&&r.status<500;throw e;}assert(d&&!d.error,'EXTENSION_CONTRACT',502);return d;}
 async list(){const d=await this.call('subscribers/all');assert(d.accountId&&Array.isArray(d.subscribers),'EXTENSION_CONTRACT',502);return{accountId:String(d.accountId),subscribers:d.subscribers.map(normalizeSubscriber)};}
 async validate(){assert(typeof this.token==='string'&&/^@[^\s\u0000-\u001f\u007f]{1,511}$/.test(this.token),'INVALID_ADMIN_TOKEN');const p=await this.call('validate','POST',{token:this.token,version:this.version});assert(p.message&&p.account?.id&&p.agent,'EXTENSION_UNAUTHORIZED',403);const listing=await this.list();assert(listing.accountId===String(p.account.id),'EXTENSION_SCOPE',403);return{accountId:listing.accountId,count:listing.subscribers.length};}
 create(fullName,expiresAt){return this.call('subscribers/create','POST',{name:fullName,expiresAt});}
 update(remoteId,expiresAt){return this.call('subscribers/update','PATCH',{subscriptionId:remoteId,expiresAt});}
}
