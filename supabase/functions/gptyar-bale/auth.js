import {assert,digits} from './domain.js';
import {hash,random,passwordHash,passwordVerify,newTotp,totpCounter} from './crypto.js';
export function validateCredentials(b){assert(typeof b.username==='string'&&/^[a-zA-Z0-9_.-]{3,40}$/.test(b.username),'INVALID_USERNAME');assert(typeof b.password==='string'&&b.password.length>=12&&b.password.length<=128,'WEAK_PASSWORD');}
export async function authRoute(ctx,path,req,body){
 const ip=req.headers.get('cf-connecting-ip')||req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';
 if(path==='/auth/status'&&req.method==='GET')return{configured:!!await ctx.db.one('admins','active=eq.true&select=id')};
 if(path==='/auth/setup'&&req.method==='POST'){
  await ctx.rate(`setup:${ip}`,5);await ctx.rate('setup:global',20);validateCredentials(body);
  assert(typeof body.code==='string'&&/^[a-f0-9]{64}$/.test(body.code),'SETUP_DENIED',403);
  const code=await hash(body.code),b=await ctx.db.one('bootstrap',`id=eq.true&code_hash=eq.${code}&used_at=is.null&expires_at=gt.${new Date().toISOString()}`);
  assert(b,'SETUP_DENIED',403);
  const token=random(),secret=newTotp();
  const id=await ctx.db.rpc('setup',{p_code:code,p_username:body.username.toLowerCase(),p_password:await passwordHash(body.password),p_secret:await ctx.encrypt(secret,'totp'),p_session:await hash(token)});
  return{challenge:token,uri:`otpauth://totp/GPTYar:${encodeURIComponent(body.username)}?secret=${secret}&issuer=GPTYar&algorithm=SHA1&digits=6&period=30`,manual_key:secret,admin_id:id};
 }
 if(path==='/auth/login'&&req.method==='POST'){
  await ctx.rate(`login:${ip}`,8);await ctx.rate('login:global',80);assert(typeof body.username==='string'&&body.username.length<=40&&typeof body.password==='string'&&body.password.length<=128,'AUTH_DENIED',401);
  const a=await ctx.db.one('admins',`username=eq.${encodeURIComponent(body.username.toLowerCase())}&active=eq.true`);
  const valid=await passwordVerify(body.password,a?.password_hash||'pbkdf2:600000:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000');
  assert(a&&valid,'AUTH_DENIED',401);return{challenge:await ctx.session(a)};
 }
 if(path==='/auth/verify'&&req.method==='POST'){
  assert(typeof body.challenge==='string'&&/^[a-f0-9]{64}$/.test(body.challenge),'CHALLENGE_EXPIRED',401);
  const challengeHash=await hash(body.challenge);await ctx.rate(`otp:${challengeHash}`,6,300);await ctx.rate(`otp-ip:${ip}`,30,300);
  const s=await ctx.db.one('sessions',`token_hash=eq.${challengeHash}&expires_at=gt.${new Date().toISOString()}`);
  assert(s&&['setup','mfa'].includes(s.stage),'CHALLENGE_EXPIRED',401);
  const a=await ctx.db.one('admins',`id=eq.${s.admin_id}`),code=digits(body.code).replace(/-/g,'').toUpperCase();
  const secret=await ctx.decrypt(a.totp_secret,'totp');
  const counter=await totpCounter(secret,code);let recovery=null;
  if(counter===null){assert(s.stage==='mfa'&&/^[A-F0-9]{16}$/.test(code),'INVALID_OTP',401);recovery=await hash(`${a.id}:${code}`);assert(await ctx.db.one('recovery_codes',`code_hash=eq.${recovery}&admin_id=eq.${a.id}&used_at=is.null`),'INVALID_OTP',401);}
  const token=random(),recoveryCodes=s.stage==='setup'?Array.from({length:8},()=>random(8).toUpperCase()):undefined;
  const result=s.stage==='setup'
   ?await ctx.db.rpc('enroll_auth',{p_challenge:challengeHash,p_counter:counter,p_next:await hash(token),p_codes:await Promise.all(recoveryCodes.map(code=>hash(`${a.id}:${code}`)))})
   :await ctx.db.rpc('finish_auth',{p_challenge:challengeHash,p_counter:counter??0,p_next:await hash(token),p_recovery:recovery});
  return{token,username:result.username,recovery_codes:recoveryCodes};
 }
 return null;
}
export async function authenticate(ctx,req){
 const token=req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];assert(token,'AUTH_REQUIRED',401);
 const tokenHash=await hash(token),s=await ctx.db.one('sessions',`token_hash=eq.${tokenHash}&stage=eq.auth&expires_at=gt.${new Date().toISOString()}`);assert(s,'AUTH_REQUIRED',401);
 const a=await ctx.db.one('admins',`id=eq.${s.admin_id}&active=eq.true`);assert(a,'AUTH_REQUIRED',401);return{admin:a,session:s,tokenHash};
}
