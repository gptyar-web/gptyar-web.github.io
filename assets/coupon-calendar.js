/* Persian coupon date/time calendar for GPTYAR. */
(function calendarScript(){
  'use strict';
  const DAY=86400000,ZONE='Asia/Tehran';
  const MONTHS=['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
  const WEEK=['ش','ی','د','س','چ','پ','ج'];
  const greg=new Intl.DateTimeFormat('en-US',{timeZone:ZONE,year:'numeric',month:'numeric',day:'numeric'});
  const pers=new Intl.DateTimeFormat('en-US-u-ca-persian',{timeZone:ZONE,year:'numeric',month:'numeric',day:'numeric'});
  const persFull=new Intl.DateTimeFormat('fa-IR-u-ca-persian',{timeZone:ZONE,day:'numeric',month:'long',year:'numeric'});
  const num=n=>Number(n).toLocaleString('fa-IR',{useGrouping:false});
  const num2=n=>Number(n).toLocaleString('fa-IR',{minimumIntegerDigits:2,useGrouping:false});
  const parts=(formatter,date)=>Object.fromEntries(formatter.formatToParts(date).filter(p=>['year','month','day'].includes(p.type)).map(p=>[p.type,Number(p.value)]));
  function iranDay(when=new Date()){
    const p=parts(greg,when);
    return new Date(Date.UTC(p.year,p.month-1,p.day,8,30));
  }
  const jdate=day=>parts(pers,day);
  const beginning=day=>new Date(day.getTime()-(jdate(day).day-1)*DAY);
  const shiftMonth=(start,delta)=>beginning(new Date(start.getTime()+(delta>0?34:-1)*DAY));
  const sameDay=(a,b)=>a.getTime()===b.getTime();
  const toISO=(day,hour,minute)=>new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),day.getUTCDate(),hour-3,minute-30)).toISOString();
  function announce(message,error=false){
    const toast=document.getElementById('toast');
    if(!toast){if(error)alert(message);return;}
    toast.textContent=message;toast.className='show '+(error?'error':'success');
    setTimeout(()=>{if(toast.textContent===message)toast.className='';},5500);
  }
  function mount(form){
    if(form.dataset.persianCalendar==='ready')return;
    const native=form.querySelector('input[name="expires_at"]');
    if(!native)return;
    form.dataset.persianCalendar='ready';
    const target=native.closest('label')||native;
    const shell=document.createElement('section');
    shell.className='gpy-expiry';shell.setAttribute('aria-label','تاریخ و ساعت انقضای کد تخفیف');
    shell.innerHTML=`
      <div class="gpy-expiry-label">اعتبار کد تخفیف <span class="gpy-optional">زمان‌بندی هوشمند</span></div>
      <div class="gpy-expiry-modes" role="radiogroup" aria-label="نوع اعتبار">
        <label><input type="radio" name="coupon_expiry_mode" value="dated" checked><span>انتخاب تاریخ انقضا</span></label>
        <label><input type="radio" name="coupon_expiry_mode" value="unlimited"><span>بدون تاریخ انقضا ∞</span></label>
      </div>
      <div class="gpy-expiry-calendar">
        <div class="gpy-cal-heading">
          <div><span class="gpy-cal-kicker">تقویم شمسی</span><strong class="gpy-cal-month-label"></strong></div>
          <div class="gpy-cal-nav">
            <button type="button" data-cal-prev aria-label="ماه قبل">‹</button>
            <button type="button" data-cal-today>امروز</button>
            <button type="button" data-cal-next aria-label="ماه بعد">›</button>
          </div>
        </div>
        <div class="gpy-cal-body">
          <div class="gpy-cal-days" aria-hidden="true"></div>
          <div class="gpy-cal-grid" role="group" aria-label="روزهای ماه"></div>
        </div>
        <div class="gpy-cal-time">
          <div><strong>ساعت پایان اعتبار</strong><small>به وقت رسمی ایران</small></div>
          <div class="gpy-cal-time-select">
            <label aria-label="ساعت"><select name="coupon_hour"></select></label><span>:</span><label aria-label="دقیقه"><select name="coupon_minute"></select></label>
          </div>
        </div>
        <div class="gpy-cal-picked" role="status" aria-live="polite"></div>
      </div>
      <p class="gpy-cal-hint">تاریخ‌ها شمسی نمایش داده می‌شوند و زمان در سرور به‌صورت دقیق ذخیره می‌شود.</p>`;
    target.replaceWith(shell);
    let chosen=new Date(iranDay().getTime()+DAY),monthStart=beginning(chosen);
    const days=shell.querySelector('.gpy-cal-days'),grid=shell.querySelector('.gpy-cal-grid');
    days.innerHTML=WEEK.map(d=>`<span>${d}</span>`).join('');
    const hourEl=shell.querySelector('select[name="coupon_hour"]'),minuteEl=shell.querySelector('select[name="coupon_minute"]');
    for(let i=0;i<24;i++)hourEl.add(new Option(num2(i),String(i)));
    for(let i=0;i<60;i++)minuteEl.add(new Option(num2(i),String(i)));
    hourEl.value='23';minuteEl.value='59';
    function picked(){
      shell.querySelector('.gpy-cal-picked').textContent='پایان اعتبار: '+persFull.format(chosen)+'، ساعت '+num2(hourEl.value)+':'+num2(minuteEl.value);
    }
    function render(){
      const p=jdate(monthStart);
      shell.querySelector('.gpy-cal-month-label').textContent=MONTHS[p.month-1]+' '+num(p.year);
      grid.replaceChildren();
      const lead=(monthStart.getUTCDay()+1)%7;
      for(let i=0;i<lead;i++){const spacer=document.createElement('span');spacer.className='gpy-cal-spacer';grid.append(spacer);}
      for(let i=0;i<32;i++){
        const day=new Date(monthStart.getTime()+i*DAY),jp=jdate(day);
        if(jp.month!==p.month||jp.year!==p.year)break;
        const btn=document.createElement('button');
        btn.type='button';btn.className='gpy-cal-day';btn.textContent=num(jp.day);
        btn.setAttribute('aria-label',persFull.format(day));
        btn.setAttribute('aria-pressed',String(sameDay(day,chosen)));
        if(day.getUTCDay()===5)btn.classList.add('gpy-cal-friday');
        if(sameDay(day,iranDay()))btn.classList.add('gpy-cal-today');
        if(sameDay(day,chosen))btn.classList.add('gpy-cal-selected');
        if(day<iranDay())btn.disabled=true;
        btn.addEventListener('click',()=>{chosen=day;render();});
        grid.append(btn);
      }
      picked();
    }
    shell.querySelector('[data-cal-prev]').addEventListener('click',()=>{monthStart=shiftMonth(monthStart,-1);render();});
    shell.querySelector('[data-cal-next]').addEventListener('click',()=>{monthStart=shiftMonth(monthStart,1);render();});
    shell.querySelector('[data-cal-today]').addEventListener('click',()=>{chosen=iranDay();monthStart=beginning(chosen);render();});
    hourEl.addEventListener('change',picked);minuteEl.addEventListener('change',picked);
    shell.querySelectorAll('input[name="coupon_expiry_mode"]').forEach(input=>input.addEventListener('change',()=>{
      const unlimited=shell.querySelector('input[value="unlimited"]').checked;
      shell.querySelector('.gpy-expiry-calendar').hidden=unlimited;
      shell.querySelector('.gpy-cal-hint').textContent=unlimited?'این کد تا زمان غیرفعال‌سازی یا رسیدن به سقف استفاده، معتبر می‌ماند.':'تاریخ‌ها شمسی نمایش داده می‌شوند و زمان در سرور به‌صورت دقیق ذخیره می‌شود.';
    }));
    form.addEventListener('submit',async event=>{
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
      if(!form.reportValidity()||form.dataset.sending==='yes')return;
      const data=Object.fromEntries(new FormData(form).entries());
      const unlimited=data.coupon_expiry_mode==='unlimited';
      delete data.coupon_expiry_mode;delete data.coupon_hour;delete data.coupon_minute;
      data.expires_at=unlimited?null:toISO(chosen,Number(hourEl.value),Number(minuteEl.value));
      if(!unlimited&&Date.parse(data.expires_at)<=Date.now()){announce('تاریخ و ساعت انقضا باید در آینده باشد.',true);return;}
      if(data.kind==='percent'&&Number(data.value)>100){announce('درصد تخفیف نباید بیشتر از ۱۰۰ باشد.',true);return;}
      const save=form.querySelector('button[type="submit"]');
      form.dataset.sending='yes';if(save)save.disabled=true;
      try{
        const token=sessionStorage.getItem('gpyb_session');
        if(!token)throw Error('نشست مدیریت منقضی شده است. دوباره وارد شوید.');
        const res=await fetch('https://efibfevyiepkwpnobaro.supabase.co/functions/v1/gptyar-bale/coupons',{
          method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(data),signal:AbortSignal.timeout(30000)
        });
        const result=await res.json().catch(()=>({}));
        if(!res.ok)throw Error(({
          INVALID_EXPIRY:'تاریخ انقضا نامعتبر است.',INVALID_COUPON_CODE:'ساختار کد تخفیف نامعتبر است.',
          INVALID_NUMBER:'مقادیر عددی واردشده معتبر نیستند.',RATE_LIMIT:'تعداد درخواست‌ها زیاد است. دوباره امتحان کنید.',
          AUTH_REQUIRED:'نشست مدیریت منقضی شده است.',DATABASE_ERROR:'ثبت کد انجام نشد؛ احتمالاً این کد قبلاً ثبت شده است.'
        })[result.error]||'ثبت کد تخفیف انجام نشد. لطفاً دوباره تلاش کنید.');
        announce('کد تخفیف با موفقیت ثبت شد.');
        location.hash='#coupons';location.reload();
      }catch(e){announce(e.message||'خطا در ثبت کد تخفیف',true);}
      finally{form.dataset.sending='no';if(save)save.disabled=false;}
    });
    render();
  }
  function refresh(){
    const form=document.getElementById('coupon-form');
    if(form)mount(form);
    document.querySelectorAll('.coupon-card').forEach(card=>{
      const details=card.querySelectorAll('.coupon-info small');
      if(details.length>1&&/انقضا:\s*—/.test(details[1].textContent))details[1].textContent=details[1].textContent.replace(/انقضا:\s*—/,'انقضا: نامحدود ∞');
    });
  }
  const observer=new MutationObserver(refresh);
  if(document.body){observer.observe(document.body,{childList:true,subtree:true});refresh();}
  else document.addEventListener('DOMContentLoaded',()=>{observer.observe(document.body,{childList:true,subtree:true});refresh();},{once:true});
})();
