const enc=new TextEncoder();
export const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
export const unhex=s=>Uint8Array.from(s.match(/.{2}/g)||[],x=>parseInt(x,16));
export const random=(n=32)=>hex(crypto.getRandomValues(new Uint8Array(n)));
export const hash=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(String(s))));
export function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
export async function passwordHash(password,salt=random(16),iterations=600000){
 const k=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
 const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:unhex(salt),iterations},k,256);
 return `pbkdf2:${iterations}:${salt}:${hex(bits)}`;
}
export async function passwordVerify(password,stored){
 const [type,n,salt]=String(stored).split(':');
 if(type!=='pbkdf2'||Number(n)!==600000||!/^[a-f0-9]{32}$/.test(salt))return false;
 return equal(await passwordHash(password,salt,Number(n)),stored);
}
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes){let out='',bits=0,value=0;for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;}
export function decode32(s){let bits=0,value=0,out=[];for(const c of s.replace(/=+$/,'')){const n=alphabet.indexOf(c);if(n<0)throw new Error('INVALID_SECRET');value=(value<<5)|n;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return new Uint8Array(out);}
export const newTotp=()=>base32(crypto.getRandomValues(new Uint8Array(20)));
export async function totp(secret,counter=Math.floor(Date.now()/30000)){
 const bytes=new Uint8Array(8);new DataView(bytes.buffer).setBigUint64(0,BigInt(counter));
 const key=await crypto.subtle.importKey('raw',decode32(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);
 const sig=new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes)),offset=sig[19]&15;
 const n=(((sig[offset]&127)<<24)|(sig[offset+1]<<16)|(sig[offset+2]<<8)|sig[offset+3])%1000000;
 return String(n).padStart(6,'0');
}
export async function totpCounter(secret,code,now=Date.now()){
 if(!/^\d{6}$/.test(code))return null;
 const c=Math.floor(now/30000);
 for(const delta of [0,-1,1])if(equal(await totp(secret,c+delta),code))return c+delta;
 return null;
}
// Dedicated context and authenticated purpose prevent using ciphertext across fields.
// Set GPTYAR_BALE_ENCRYPTION_KEY for an independently managed production encryption key.
export async function cipherKey(env){
 const material=env.GPTYAR_BALE_ENCRYPTION_KEY||env.SUPABASE_SERVICE_ROLE_KEY;
 if(!material)throw new Error('SERVER_CONFIGURATION');
 const raw=await crypto.subtle.importKey('raw',enc.encode(material),'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:enc.encode('gptyar-bale-v1'),info:enc.encode('private-database-fields')},raw,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function seal(value,purpose,key){const iv=crypto.getRandomValues(new Uint8Array(12));const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(purpose)},key,enc.encode(value));return `v1:${hex(iv)}:${hex(ciphertext)}`;}
export async function open(value,purpose,key){const [v,iv,body]=String(value).split(':');if(v!=='v1')throw new Error('INVALID_CIPHERTEXT');return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unhex(iv),additionalData:enc.encode(purpose)},key,unhex(body)));}
