// Persian (Jalali) coupon expiration picker; dates are persisted as ISO UTC.
const fa = new Intl.DateTimeFormat('en-US-u-ca-persian',{timeZone:'Asia/Tehran',year:'numeric',month:'numeric',day:'numeric'});
const longMonth = new Intl.DateTimeFormat('fa-IR-u-ca-persian',{timeZone:'Asia/Tehran',month:'long',year:'numeric'});
const midnight = d=>new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),12));
const parts = d=>{const p=Object.fromEntries(fa.formatToParts(d).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));return p;};
const first = d=>{let t=midnight(d);const p=parts(t);t.setUTCDate(t.getUTCDate()-(p.day-1));return t;};
const state=new WeakMap();
const pad=n=>String(n).padStart(2,'0');
const pretty=n=>Number(n).toLocaleString('fa-IR');
const today=()=>midnight(new Date(Date.now()+12600000));
function show(box){
 let s=state.get(box);if(!s){s={month:first(today()),chosen:null};state.set(box,s);}
 const start=first(s.month),month=parts(start),next=midnight(new Date(start.getTime()+32*86400000));const total=Math.round((first(next)-start)/86400000);
 const offset=(start.getUTCDay()+1)%7; // Saturday = 0
 const now=today(),days=['ش','ی','د','س','چ','پ','ج'];
 const items=days.map(x=>'<span class="jalali-weekday">'+x+'</span>');
 for(let i=0;i<offset;i++)items.push('<span aria-hidden="true"></span>');
 for(let i=1;i<=total;i++){
  const d=new Date(start.getTime()+(i-1)*86400000);
  const iso=d.toISOString().slice(0,10);
  const active=s.chosen===iso,old=d<now,isToday=d.getTime()===now.getTime();
  items.push('<button type="button" class="jalali-day'+(active?' selected':'')+(isToday?' today':'')+'" data-jday="'+iso+'" '+(old?'disabled':'')+' aria-label="'+pretty(i)+'" aria-pressed="'+active+'">'+pretty(i)+'</button>');
 }
 const popup=box.querySelector('.jalali-popup');
 popup.innerHTML='<div class="jalali-head"><button type="button" data-jmove="-1" aria-label="ماه قبل">❯</button><strong>'+longMonth.format(start)+'</strong><button type="button" data-jmove="1" aria-label="ماه بعد">❮</button></div><div class="jalali-grid">'+items.join('')+'</div><div class="jalali-footer"><span>زمان به وقت تهران</span><button type="button" data-jtoday>انتخاب امروز</button></div>';
}
function setDate(box,date){
 const s=state.get(box)||{month:first(today()),chosen:null};s.chosen=date.toISOString().slice(0,10);s.month=first(date);state.set(box,s);
 const p=parts(date);box.querySelector('.jalali-date-label').textContent=pretty(p.year)+'/'+pad(p.month).replace(/\d/g,x=>pretty(x))+'/'+pad(p.day).replace(/\d/g,x=>pretty(x));
 box.querySelector('.jalali-popup').hidden=true;
 update(box);
}
function update(box){
 const unlimited=box.querySelector('[name="never_expires"]').checked,field=box.querySelector('[name="expires_at"]'),button=box.querySelector('[data-jopen]'),s=state.get(box);
 button.disabled=unlimited;
 box.querySelector('.jalali-time').hidden=unlimited;
 if(unlimited){field.value='';box.querySelector('.jalali-popup').hidden=true;return;}
 if(!s?.chosen){field.value='';return;}
 const [y,m,d]=s.chosen.split('-').map(Number);
 const hour=Number(box.querySelector('[name="expiry_hour"]').value),minute=Number(box.querySelector('[name="expiry_minute"]').value);
 const utc=new Date(Date.UTC(y,m-1,d,hour,minute)-12600000);
 field.value=utc.toISOString();
}
document.addEventListener('click',e=>{
 const t=e.target,box=t.closest?.('.jalali-picker');
 if(!box){for(const p of document.querySelectorAll('.jalali-popup'))p.hidden=true;return;}
 if(t.closest('[data-jopen]')){const popup=box.querySelector('.jalali-popup');if(popup.hidden){show(box);popup.hidden=false;}else popup.hidden=true;}
 const move=t.closest('[data-jmove]');if(move){const s=state.get(box)||{month:first(today()),chosen:null};const start=first(s.month);const jump=Number(move.dataset.jmove)>0?32:-2;s.month=first(new Date(start.getTime()+jump*86400000));state.set(box,s);show(box);}
 const day=t.closest('[data-jday]');if(day&&!day.disabled)setDate(box,new Date(day.dataset.jday+'T12:00:00Z'));
 if(t.closest('[data-jtoday]'))setDate(box,today());
});
document.addEventListener('change',e=>{
 const box=e.target.closest?.('.jalali-picker');if(box&&e.target.matches('[name="never_expires"],[name="expiry_hour"],[name="expiry_minute"]'))update(box);
});
