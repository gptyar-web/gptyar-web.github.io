import {context} from './context.js';
import {authRoute,authenticate} from './auth.js';
import {adminRoute} from './admin.js';
import {handleMessage,preCheckout} from './bot.js';
import {hash,equal} from './crypto.js';
import {assert,AppError} from './domain.js';
const ORIGINS=new Set(['https://gptyar-web.github.io','http://localhost:5173','http://127.0.0.1:5173','http://terminal.local:4173']);
const BASE_HEADERS={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
export const routePath=pathname=>pathname.replace(/^\/(?:functions\/v1\/)?gptyar-bale(?=\/|$)/,'').replace(/\/$/,'')||'/';
export async function bodyJSON(req){
 const limit=65536;assert(Number(req.headers.get('content-length')||0)<=limit,'BODY_TOO_LARGE',413);
 if(!req.body)return{};
 const reader=req.body.getReader(),chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new AppError('BODY_TOO_LARGE',413);}chunks.push(value);}}finally{reader.releaseLock();}
 if(!size)return{};const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 let result;try{result=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new AppError('INVALID_JSON');}
 assert(result&&typeof result==='object'&&!Array.isArray(result),'INVALID_JSON');return result;
}
export function createHandler(env,transport=fetch){return async req=>{
 const headers={...BASE_HEADERS};let ctx,updateOwner,updateId,botId;
 try{
  const origin=req.headers.get('origin');assert(!origin||ORIGINS.has(origin),'ORIGIN_DENIED',403);
  if(origin){headers['Access-Control-Allow-Origin']=origin;headers.Vary='Origin';}
  headers['Access-Control-Allow-Headers']='authorization,content-type';headers['Access-Control-Allow-Methods']='GET,POST,PUT,PATCH,OPTIONS';
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  const url=new URL(req.url);let path=routePath(url.pathname);
  if(path==='/health')return new Response(JSON.stringify({ok:true,service:'gptyar-bale',version:'1.1.0'}),{headers});
  ctx=await context(env,transport);let body={};
  if(!['GET','HEAD'].includes(req.method))body=await bodyJSON(req);
  const webhook=path.match(/^\/webhook\/([a-f0-9]{64})$/);
  if(webhook){
   assert(req.method==='POST','METHOD_NOT_ALLOWED',405);const secret=await ctx.secret('webhook');assert(secret&&equal(await hash(secret),await hash(webhook[1])),'WEBHOOK_DENIED',403);
   botId=(await ctx.settings()).bot_id;assert(botId,'BOT_NOT_CONFIGURED',409);
   assert(Number.isSafeInteger(body.update_id)&&body.update_id>=0,'INVALID_UPDATE');
   if(body.pre_checkout_query){await preCheckout(ctx,body.pre_checkout_query);return new Response(JSON.stringify({ok:true}),{headers});}
   const msg=body.message;if(!msg||msg.chat?.type!=='private'||!Number.isSafeInteger(msg.from?.id)||msg.from.id<1||msg.from.id!==msg.chat?.id)return new Response(JSON.stringify({ok:true}),{headers});
   updateId=body.update_id;updateOwner=crypto.randomUUID();
   if(!await ctx.db.rpc('claim_bot_update',{p_bot:botId,p_id:updateId,p_owner:updateOwner})){
    const existing=await ctx.db.one('updates',`bot_id=eq.${botId}&update_id=eq.${updateId}`);if(existing?.status==='done')return new Response(JSON.stringify({ok:true,duplicate:true}),{headers});throw new AppError('BUSY_RETRY',503);
   }
   ctx.updateId=updateId;ctx.requestKey=`bot:${botId}:update:${updateId}`;
   await ctx.lease(`chat:${msg.from.id}`,()=>handleMessage(ctx,msg));
   await ctx.db.patch('updates',`bot_id=eq.${botId}&update_id=eq.${updateId}&owner=eq.${updateOwner}`,{status:'done',error_code:null});return new Response(JSON.stringify({ok:true}),{headers});
  }
  if(path.startsWith('/webhook'))throw new AppError('WEBHOOK_DENIED',403);
  let result=await authRoute(ctx,path,req,body);
  if(result===null){const auth=await authenticate(ctx,req);result=await adminRoute(ctx,path,req,body,auth);}
  assert(result!==null,'NOT_FOUND',404);return new Response(JSON.stringify(result),{headers});
 }catch(e){
  const code=e instanceof AppError?e.code:'INTERNAL_ERROR',status=e instanceof AppError?e.status:500;
  if(ctx&&updateId!==undefined&&updateOwner)await ctx.db.patch('updates',`bot_id=eq.${botId}&update_id=eq.${updateId}&owner=eq.${updateOwner}&status=eq.processing`,{status:'error',error_code:code}).catch(()=>{});
  // Never log request bodies, URLs containing webhook secrets, upstream errors, or credentials.
  return new Response(JSON.stringify({error:code}),{status,headers});
 }
};}
if(typeof Deno!=='undefined'&&import.meta.main)Deno.serve(createHandler(Deno.env.toObject()));
