import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {installCalendar,tehranDay,jalaliParts,monthStart,shiftMonth,monthLength,expirationISO} from '../web/src/coupon-calendar.js';

const source=(await readFile(new URL('../web/src/app.js',import.meta.url),'utf8')).replace(/^import .+;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nwindow.ui={navigate,showAuth,init,viewOrders,viewCoupons,showOrderRecovery};');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function waitFor(predicate){for(let i=0;i<30;i++){if(predicate())return;await tick();}assert.fail('UI action did not complete');}
function panel(handler=async()=>Response.json({})){const dom=new JSDOM('<div id="app"></div><div id="toast"></div>',{url:'https://gptyar-web.github.io/',runScripts:'outside-only'}),w=dom.window;
 w.installCalendar=installCalendar;w.AbortSignal=AbortSignal;w.fetch=handler;w.QRCode={toString:async()=>'<svg></svg>'};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 w.sessionStorage.setItem('gpyb_session','a'.repeat(64));w.eval(source);return{dom,w,ui:w.ui};
}
const click=(w,selector)=>{const el=w.document.querySelector(selector);assert.ok(el,selector);el.click();};
const change=(w,el)=>el.dispatchEvent(new w.Event('change',{bubbles:true}));
const submit=(w,selector)=>w.document.querySelector(selector).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));

test('Tehran civil day handles UTC midnight boundaries and correct Persian month lengths',()=>{
 assert.equal(tehranDay(new Date('2026-10-23T20:29:00Z')).toISOString(),'2026-10-23T12:00:00.000Z');
 assert.equal(tehranDay(new Date('2026-10-23T20:30:00Z')).toISOString(),'2026-10-24T12:00:00.000Z');
 const march=tehranDay(new Date('2026-03-10T12:00:00Z'));assert.equal(jalaliParts(march).month,12);assert.equal(monthLength(march),29);
 const leap=tehranDay(new Date('2025-03-10T12:00:00Z'));assert.equal(monthLength(leap),30);
 let start=monthStart(tehranDay(new Date('2026-04-01T12:00:00Z')));
 for(let i=0;i<12;i++){assert.equal(monthLength(start),i<6?31:i<11?30:29);const next=shiftMonth(start,1);assert.equal(shiftMonth(next,-1).getTime(),start.getTime());start=next;}
 assert.equal(expirationISO(new Date('2026-10-24T12:00:00Z'),0,15),'2026-10-23T20:45:00.000Z');
});
test('coupon form saves unlimited and Jalali dated coupons once through the main API',async()=>{
 const posts=[];const p=panel(async(url,opts)=>{if(opts.method==='POST'){posts.push(JSON.parse(opts.body));return Response.json({row:{}});}return Response.json({rows:[],page:1,has_more:false});}),{w,ui}=p;
 try{
  await ui.navigate('coupons');
  function fill(){for(const [key,value]of Object.entries({code:'WELCOME',value:'100',max_uses:'5',per_user_limit:'1'}))w.document.querySelector(`[name="${key}"]`).value=value;}
  fill();let unlimited=w.document.querySelector('[name="never_expires"]');unlimited.checked=true;change(w,unlimited);submit(w,'#coupon-form');await waitFor(()=>posts.length===1&&w.document.querySelector('#coupon-form [name=code]')?.value==='');
  assert.equal(posts[0].expires_at,null);
  fill();click(w,'[data-jopen]');const days=[...w.document.querySelectorAll('[data-jday]:not(:disabled)')];assert.ok(days.length);const chosen=days.at(-1);const day=chosen.dataset.jday;chosen.click();
  assert.ok(!w.document.querySelector('.jalali-date-label').textContent.includes('٬'));
  submit(w,'#coupon-form');await waitFor(()=>posts.length===2&&w.document.querySelector('#coupon-form [name=code]')?.value==='');assert.equal(posts[1].expires_at,expirationISO(new Date(day+'T12:00:00Z'),23,59));assert.equal(posts.length,2);
 }finally{p.dom.window.close();}
});
test('OTP accepts Persian digits and completes the second login step',async()=>{
 let otp;const p=panel(async(url,opts)=>{
  if(url.endsWith('/auth/status'))return Response.json({configured:true});
  if(url.endsWith('/auth/login'))return Response.json({challenge:'b'.repeat(64)});
  if(url.endsWith('/auth/verify')){otp=JSON.parse(opts.body);return Response.json({token:'c'.repeat(64),username:'admin'});}
  if(url.endsWith('/overview'))return Response.json({metrics:{revenue:0,orders:0,customers:0,active_subscriptions:0,today_revenue:0,series:[]},settings:{},integrations:[],recent:[]});
  return Response.json({});
 });
 try{
  await p.ui.showAuth();const d=p.w.document;d.querySelector('[name=username]').value='admin';d.querySelector('[name=password]').value='valid-password-test';submit(p.w,'#login-form');await waitFor(()=>d.querySelector('#otp-form'));
  d.querySelector('[name=code]').value='۱۲۳۴۵۶';submit(p.w,'#otp-form');await waitFor(()=>d.querySelector('.stats-grid'));assert.equal(otp.code,'123456');assert.equal(p.w.sessionStorage.getItem('gpyb_session'),'c'.repeat(64));
 }finally{p.dom.window.close();}
});
test('transient connection failures retain the authenticated session for retry',async()=>{
 const p=panel(async()=>{throw new Error('offline');});try{p.w.sessionStorage.setItem('gpyb_session','a'.repeat(64));await p.ui.init();assert.equal(p.w.sessionStorage.getItem('gpyb_session'),'a'.repeat(64));assert.ok(p.w.document.querySelector('[data-action=reload]'));}finally{p.dom.window.close();}
});
test('ambiguous account recovery is available in the panel and escapes names',()=>{
 const p=panel();try{
  const html=p.ui.viewOrders({rows:[{id:'11111111-1111-4111-8111-111111111111',full_name:'<img src=x onerror=alert(1)>',status:'review',kind:'purchase',created_at:'2026-10-23T00:00:00Z'}],page:1,has_more:false});
  const doc=p.w.document;doc.querySelector('#app').innerHTML=html;assert.equal(doc.querySelector('img'),null);assert.ok(doc.querySelector('[data-action=resolve]'));
  click(p.w,'[data-action=resolve]');assert.ok(doc.querySelector('#resolve-form input[type=password]'));
 }finally{p.dom.window.close();}
});
test('all three connection tokens can be replaced from the panel and removed connections are absent',async()=>{
 const posted=[],settings={bot_username:'test_bot',extension_account_id:'old-account',extension_version:'4.6.5',daily_price_toman:35000,max_days:365};
 let settingsReads=0;
 const p=panel(async(url,opts)=>{
  if(url.endsWith('/integrations/check'))return Response.json({bale_bot:{ok:true},extension_admin:{ok:true},bale_payment:{saved:true}});
  if(opts.method==='POST'){const data=JSON.parse(opts.body);posted.push(data);return Response.json({ok:true,wallet_reset:data.kind==='bale_bot'});}
  settingsReads++;return Response.json({settings,integrations:['bale_bot','bale_payment','extension_admin'].map(key=>({key})),links:[]});
 });
 try{
  await p.ui.navigate('integrations');const doc=p.w.document;
  assert.equal(doc.querySelectorAll('form[data-integration]').length,3);assert.ok(!doc.body.textContent.includes('روبیکا'));
  for(const [kind,token]of [['bale_bot','456:new-bot-token'],['bale_payment','new-wallet-token'],['extension_admin','@new-manager-token']]){
   const selector=`form[data-integration="${kind}"]`;const form=doc.querySelector(selector);
   assert.match(form.textContent,/جایگزینی/);assert.equal(form.elements.token.type,'password');assert.equal(form.elements.token.value,'');
   form.elements.token.value=token;const previous=settingsReads;submit(p.w,selector);
   await waitFor(()=>settingsReads>previous&&doc.querySelector(selector)?.elements.token.value==='');
   assert.deepEqual(posted.at(-1),{kind,token});assert.ok(!doc.body.textContent.includes(token));
   if(kind==='bale_bot')assert.match(doc.querySelector('#toast').textContent,/کیف پول همین ربات/);
  }
  click(p.w,'[data-action=check-integrations]');await waitFor(()=>doc.querySelector('#connection-results').textContent.includes('نتیجه بررسی'));
  assert.ok(!doc.querySelector('#connection-results').textContent.includes('روبیکا'));
 }finally{p.dom.window.close();}
});
