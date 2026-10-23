import {Database,Bale,Extension} from './clients.js';
import {cipherKey,seal,open,hash,random} from './crypto.js';
import {assert} from './domain.js';
export async function context(env,transport=fetch){
 const db=new Database(env,transport),key=await cipherKey(env),cache=new Map();
 const ctx={env,db,key,transport,
  encrypt:(value,purpose)=>seal(value,purpose,key),decrypt:(value,purpose)=>open(value,purpose,key),
  async secret(name){if(cache.has(name))return cache.get(name);const r=await db.one('secrets',`key=eq.${name}`);const v=r?await open(r.ciphertext,`secret:${name}`,key):null;cache.set(name,v);return v;},
  async saveSecret(name,value){await db.upsert('secrets',{key:name,ciphertext:await seal(value,`secret:${name}`,key),updated_at:new Date().toISOString()},'key');cache.set(name,value);},
  settings:()=>db.one('settings','id=eq.true'),
  async bale(){const t=await ctx.secret('bale_bot');assert(t,'BOT_NOT_CONFIGURED',409);return new Bale(t,transport);},
  async extension(){const [t,s]=await Promise.all([ctx.secret('extension_admin'),ctx.settings()]);assert(t&&s.extension_account_id,'EXTENSION_NOT_CONFIGURED',409);return new Extension(t,s.extension_version,transport);},
  async ready(){const [bot,pay,ext,s]=await Promise.all([ctx.secret('bale_bot'),ctx.secret('bale_payment'),ctx.secret('extension_admin'),ctx.settings()]);return !!(bot&&pay&&ext&&s.bot_id&&s.extension_account_id);},
  async rate(scope,max=8,seconds=900){const n=await db.rpc('rate',{p_key:await hash(scope),p_seconds:seconds});assert(n<=max,'RATE_LIMIT',429);},
  audit:(action,actor='system',detail={})=>db.insert('audit',{action,actor:String(actor),detail}),
  async lease(scope,fn){const owner=crypto.randomUUID();assert(await db.rpc('lease',{p_key:scope,p_owner:owner,p_seconds:180}),'BUSY_RETRY',503);try{return await fn();}finally{await db.delete('leases',`key=eq.${encodeURIComponent(scope)}&owner=eq.${owner}`).catch(()=>{});}},
  async session(admin,stage='mfa',minutes=5){const token=random();await db.insert('sessions',{token_hash:await hash(token),admin_id:admin.id,stage,expires_at:new Date(Date.now()+minutes*60000).toISOString()});return token;}
 };return ctx;
}
