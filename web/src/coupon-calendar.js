// One source for the Jalali picker. A civil day is represented at UTC noon.
const DAY=86400000,ZONE='Asia/Tehran';
const gregorian=new Intl.DateTimeFormat('en-US',{timeZone:ZONE,year:'numeric',month:'numeric',day:'numeric'});
const persian=new Intl.DateTimeFormat('en-US-u-ca-persian',{timeZone:ZONE,year:'numeric',month:'numeric',day:'numeric'});
const monthLabel=new Intl.DateTimeFormat('fa-IR-u-ca-persian',{timeZone:ZONE,month:'long',year:'numeric'});
const fullLabel=new Intl.DateTimeFormat('fa-IR-u-ca-persian',{timeZone:ZONE,year:'numeric',month:'long',day:'numeric'});
const parts=(formatter,date)=>Object.fromEntries(formatter.formatToParts(date).filter(p=>['year','month','day'].includes(p.type)).map(p=>[p.type,Number(p.value)]));
export const jalaliParts=date=>parts(persian,date);
export function tehranDay(now=new Date()){
 const {year,month,day}=parts(gregorian,now);return new Date(Date.UTC(year,month-1,day,12));
}
export const monthStart=date=>new Date(date.getTime()-(jalaliParts(date).day-1)*DAY);
export const shiftMonth=(date,direction)=>monthStart(new Date(monthStart(date).getTime()+(direction>0?32:-1)*DAY));
export const monthLength=date=>Math.round((shiftMonth(date,1)-monthStart(date))/DAY);
export function expirationISO(day,hour,minute){
 if(!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(minute)||minute<0||minute>59)throw new Error('INVALID_EXPIRY');
 return new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),day.getUTCDate(),hour,minute)-12600000).toISOString();
}
const pretty=n=>Number(n).toLocaleString('fa-IR',{useGrouping:false,minimumIntegerDigits:2});
export function installCalendar(doc,{now=()=>new Date()}={}){
 const states=new WeakMap();
 const get=box=>{if(!states.has(box))states.set(box,{month:monthStart(tehranDay(now())),chosen:null});return states.get(box);};
 function update(box){
  const unlimited=box.querySelector('[name="never_expires"]').checked;
  box.querySelector('[data-jopen]').disabled=unlimited;box.querySelector('.jalali-time').hidden=unlimited;
  if(unlimited){box.querySelector('[name="expires_at"]').value='';box.querySelector('.jalali-popup').hidden=true;return;}
  const chosen=get(box).chosen;
  box.querySelector('[name="expires_at"]').value=chosen?expirationISO(chosen,Number(box.querySelector('[name="expiry_hour"]').value),Number(box.querySelector('[name="expiry_minute"]').value)):'';
 }
 function render(box){
  const s=get(box),start=monthStart(s.month),today=tehranDay(now()),items=['ش','ی','د','س','چ','پ','ج'].map(x=>`<span class="jalali-weekday">${x}</span>`);
  for(let i=0;i<(start.getUTCDay()+1)%7;i++)items.push('<span aria-hidden="true"></span>');
  for(let i=0;i<monthLength(start);i++){
   const day=new Date(start.getTime()+i*DAY),selected=s.chosen?.getTime()===day.getTime();
   items.push(`<button type="button" class="jalali-day${selected?' selected':''}${day.getTime()===today.getTime()?' today':''}" data-jday="${day.toISOString().slice(0,10)}" ${day<today?'disabled':''} aria-label="${fullLabel.format(day)}" aria-pressed="${selected}">${(i+1).toLocaleString('fa-IR')}</button>`);
  }
  box.querySelector('.jalali-popup').innerHTML=`<div class="jalali-head"><button type="button" data-jmove="-1" aria-label="ماه قبل">❯</button><strong>${monthLabel.format(start)}</strong><button type="button" data-jmove="1" aria-label="ماه بعد">❮</button></div><div class="jalali-grid">${items.join('')}</div><div class="jalali-footer"><span>زمان به وقت تهران</span><button type="button" data-jtoday>انتخاب امروز</button></div>`;
 }
 function choose(box,day){
  const s=get(box);s.chosen=day;s.month=monthStart(day);const p=jalaliParts(day);
  box.querySelector('.jalali-date-label').textContent=`${p.year.toLocaleString('fa-IR',{useGrouping:false})}/${pretty(p.month)}/${pretty(p.day)}`;
  box.querySelector('.jalali-popup').hidden=true;box.querySelector('[data-jopen]').setAttribute('aria-expanded','false');update(box);
 }
 const click=e=>{
  const t=e.target,box=t.closest?.('.jalali-picker');
  if(!box){doc.querySelectorAll('.jalali-popup').forEach(p=>{p.hidden=true;p.closest('.jalali-picker').querySelector('[data-jopen]').setAttribute('aria-expanded','false');});return;}
  if(t.closest('[data-jopen]')){const p=box.querySelector('.jalali-popup');if(p.hidden)render(box);p.hidden=!p.hidden;box.querySelector('[data-jopen]').setAttribute('aria-expanded',String(!p.hidden));}
  const move=t.closest('[data-jmove]');if(move){get(box).month=shiftMonth(get(box).month,Number(move.dataset.jmove));render(box);}
  const day=t.closest('[data-jday]');if(day&&!day.disabled)choose(box,new Date(day.dataset.jday+'T12:00:00Z'));
  if(t.closest('[data-jtoday]'))choose(box,tehranDay(now()));
 };
 const change=e=>{const box=e.target.closest?.('.jalali-picker');if(box&&e.target.matches('[name="never_expires"],[name="expiry_hour"],[name="expiry_minute"]'))update(box);};
 const key=e=>{if(e.key==='Escape')doc.querySelectorAll('.jalali-popup').forEach(p=>{p.hidden=true;p.closest('.jalali-picker').querySelector('[data-jopen]').setAttribute('aria-expanded','false');});};
 doc.addEventListener('click',click);doc.addEventListener('change',change);doc.addEventListener('keydown',key);
 return()=>{doc.removeEventListener('click',click);doc.removeEventListener('change',change);doc.removeEventListener('keydown',key);};
}
