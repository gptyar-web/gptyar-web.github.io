-- Isolated GPTYar Bale schema. No existing table, Auth setting, or function is modified.
create table public.gpyb_admins (
 id uuid primary key default gen_random_uuid(), username text not null unique,
 password_hash text not null, totp_secret text not null, active boolean not null default false,
 last_totp_counter bigint not null default -1, created_at timestamptz not null default now()
);
create table public.gpyb_sessions (
 token_hash text primary key, admin_id uuid not null references public.gpyb_admins on delete cascade,
 stage text not null check(stage in ('setup','mfa','auth')), expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
create index gpyb_sessions_admin_idx on public.gpyb_sessions(admin_id);
create table public.gpyb_bootstrap (
 id boolean primary key default true check(id), code_hash text not null,
 expires_at timestamptz not null, used_at timestamptz
);
create table public.gpyb_recovery_codes (
 code_hash text primary key, admin_id uuid not null references public.gpyb_admins on delete cascade, used_at timestamptz
);
create index gpyb_recovery_admin_idx on public.gpyb_recovery_codes(admin_id);
create table public.gpyb_settings (
 id boolean primary key default true check(id), daily_price_toman integer not null default 35000 check(daily_price_toman between 1000 and 10000000),
 max_days integer not null default 365 check(max_days between 1 and 3650),
 sales_enabled boolean not null default false, extension_version text not null default '4.6.5',
 bot_username text, bot_id bigint, extension_account_id text, connected_at timestamptz,
 support_eitaa text not null default 'https://web.eitaa.com/#@gptyar',
 support_divar text not null default 'https://divar.ir/v/ga5aAJjh', updated_at timestamptz not null default now()
);
insert into public.gpyb_settings(id) values(true);
create table public.gpyb_secrets (
 key text primary key, ciphertext text not null, updated_at timestamptz not null default now()
);
create table public.gpyb_links (
 os text primary key check(os in ('android','ios','windows','mac')), title text not null,
 tutorial_url text not null, download_url text not null, note text not null default ''
);
insert into public.gpyb_links values
 ('android','اندروید','https://www.aparat.com/v/yzu9013','https://gptyar2.soservice.ir/download',''),
 ('ios','آیفون','https://www.aparat.com/v/osy001n','https://gptyar2.soservice.ir/download','مطابق آموزش، از روش سازگار با آیفون استفاده کنید.'),
 ('windows','ویندوز','https://www.aparat.com/v/raf7344','https://gptyar2.soservice.ir/download',''),
 ('mac','مک','https://www.aparat.com/v/raf7344','https://gptyar2.soservice.ir/download','آموزش کروم ویندوز برای مراحل نصب اکستنشن در کروم مک نیز قابل استفاده است؛ محل گزینه‌ها ممکن است متفاوت باشد.');
create table public.gpyb_customers (
 bale_id bigint primary key, first_name text not null default '', last_name text not null default '',
 os text references public.gpyb_links(os), created_at timestamptz not null default now()
);
create index gpyb_customers_os_idx on public.gpyb_customers(os);
create table public.gpyb_conversations (
 bale_id bigint primary key references public.gpyb_customers on delete cascade,
 state text not null default 'menu', data jsonb not null default '{}', updated_at timestamptz not null default now()
);
create table public.gpyb_coupons (
 id uuid primary key default gen_random_uuid(), code text not null unique check(code ~ '^[A-Z0-9_-]{3,32}$'),
 kind text not null check(kind in ('percent','fixed')), value integer not null check(value>0),
 max_uses integer not null default 100 check(max_uses>0), per_user_limit integer not null default 1 check(per_user_limit>0),
 expires_at timestamptz, active boolean not null default true,
 created_at timestamptz not null default now(), check(kind<>'percent' or value<=100)
);
create table public.gpyb_subscriptions (
 id uuid primary key default gen_random_uuid(), bale_id bigint not null references public.gpyb_customers,
 remote_id text not null unique, token_hash text not null unique, token_ciphertext text not null,
 expires_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index gpyb_subscription_customer_idx on public.gpyb_subscriptions(bale_id);
create table public.gpyb_orders (
 id uuid primary key default gen_random_uuid(), bale_id bigint not null references public.gpyb_customers,
 full_name text not null, kind text not null check(kind in ('purchase','renewal')),
 days integer not null check(days between 1 and 3650), subtotal_toman bigint not null check(subtotal_toman>0),
 discount_toman bigint not null default 0 check(discount_toman>=0), total_toman bigint not null check(total_toman>0),
 coupon_id uuid references public.gpyb_coupons, subscription_id uuid references public.gpyb_subscriptions,
 status text not null default 'pending' check(status in ('pending','checkout','paid','provisioning','fulfilled','review','cancelled','expired')),
 pre_checkout_id text unique, charge_id text unique, provider_charge_id text unique,
 invoice_message_id bigint, target_expires_at timestamptz, error_code text,
 created_at timestamptz not null default now(), expires_at timestamptz not null default(now()+interval '30 minutes'),
 paid_at timestamptz, fulfilled_at timestamptz,
 check(subtotal_toman-discount_toman=total_toman)
);
create index gpyb_orders_customer_idx on public.gpyb_orders(bale_id,created_at desc);
create index gpyb_orders_coupon_idx on public.gpyb_orders(coupon_id,status);
create index gpyb_orders_subscription_idx on public.gpyb_orders(subscription_id);
create index gpyb_orders_created_idx on public.gpyb_orders(created_at desc);
create index gpyb_orders_paid_idx on public.gpyb_orders(paid_at desc) where paid_at is not null;
create index gpyb_orders_expiry_idx on public.gpyb_orders(expires_at) where status='pending';
create table public.gpyb_updates (
 update_id bigint primary key, status text not null default 'processing' check(status in ('processing','done','error')),
 owner uuid not null, locked_until timestamptz not null, created_at timestamptz not null default now(), error_code text
);
create table public.gpyb_leases (key text primary key, owner uuid not null, locked_until timestamptz not null);
create table public.gpyb_rate_limits (key_hash text primary key, window_start timestamptz not null, attempts integer not null);
create table public.gpyb_audit (
 id bigint generated always as identity primary key, action text not null, actor text not null default 'system',
 detail jsonb not null default '{}', created_at timestamptz not null default now()
);
create index gpyb_audit_time_idx on public.gpyb_audit(created_at desc);

create function public.gpyb_rate(p_key text,p_seconds integer) returns integer
language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 insert into public.gpyb_rate_limits as r values(p_key,now(),1)
 on conflict(key_hash) do update set
 attempts=case when r.window_start<now()-make_interval(secs=>p_seconds) then 1 else r.attempts+1 end,
 window_start=case when r.window_start<now()-make_interval(secs=>p_seconds) then now() else r.window_start end
 returning attempts into n;
 return n;
end; $$;

create function public.gpyb_setup(p_code text,p_username text,p_password text,p_secret text,p_session text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare a uuid;
begin
 perform pg_advisory_xact_lock(hashtext('gpyb:setup'));
 if not exists(select 1 from public.gpyb_bootstrap where id and code_hash=p_code and used_at is null and expires_at>now())
 or exists(select 1 from public.gpyb_admins where active) then raise exception 'SETUP_DENIED'; end if;
 update public.gpyb_sessions set expires_at=now() where admin_id in(select id from public.gpyb_admins where not active);
 update public.gpyb_admins set username='pending_'||id::text where not active;
 insert into public.gpyb_admins(username,password_hash,totp_secret) values(p_username,p_password,p_secret) returning id into a;
 insert into public.gpyb_sessions values(p_session,a,'setup',now()+interval '15 minutes',now());
 return a;
end; $$;

create function public.gpyb_finish_auth(p_challenge text,p_counter bigint,p_next text,p_recovery text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.gpyb_sessions; a public.gpyb_admins; affected integer;
begin
 select * into s from public.gpyb_sessions where token_hash=p_challenge and expires_at>now() and stage in ('setup','mfa') for update;
 if not found then raise exception 'CHALLENGE_EXPIRED'; end if;
 select * into a from public.gpyb_admins where id=s.admin_id for update;
 if s.stage='mfa' and not a.active then raise exception 'AUTH_DENIED'; end if;
 if p_recovery is not null and s.stage='mfa' then
  update public.gpyb_recovery_codes set used_at=now() where code_hash=p_recovery and admin_id=a.id and used_at is null;
  get diagnostics affected=row_count;
  if affected<>1 then raise exception 'INVALID_OTP'; end if;
 else
  if p_counter<=a.last_totp_counter then raise exception 'OTP_REPLAY'; end if;
  update public.gpyb_admins set last_totp_counter=p_counter where id=a.id;
 end if;
 if s.stage='setup' then
  if exists(select 1 from public.gpyb_admins where active) then raise exception 'SETUP_DENIED'; end if;
  update public.gpyb_admins set active=true where id=a.id;
  update public.gpyb_bootstrap set used_at=now() where id;
 end if;
 update public.gpyb_sessions set expires_at=now() where token_hash=p_challenge;
 insert into public.gpyb_sessions values(p_next,a.id,'auth',now()+interval '8 hours',now());
 insert into public.gpyb_audit(action,actor) values('auth.login',a.username);
 return jsonb_build_object('id',a.id,'username',a.username,'enrolled',s.stage='setup');
end; $$;

create function public.gpyb_lease(p_key text,p_owner uuid,p_seconds integer default 90) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 insert into public.gpyb_leases as l values(p_key,p_owner,now()+make_interval(secs=>p_seconds))
 on conflict(key) do update set owner=p_owner,locked_until=excluded.locked_until where l.locked_until<now();
 get diagnostics n=row_count; return n=1;
end; $$;

create function public.gpyb_claim_update(p_id bigint,p_owner uuid) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 insert into public.gpyb_updates as u(update_id,owner,locked_until) values(p_id,p_owner,now()+interval '90 seconds')
 on conflict(update_id) do update set status='processing',owner=p_owner,locked_until=excluded.locked_until
 where u.status='error' or (u.status='processing' and u.locked_until<now());
 get diagnostics n=row_count; return n=1;
end; $$;

create function public.gpyb_new_order(p_user bigint,p_days integer,p_kind text,p_coupon text default null,p_subscription uuid default null)
returns public.gpyb_orders language plpgsql security invoker set search_path='' as $$
declare s public.gpyb_settings; c public.gpyb_coupons; customer public.gpyb_customers; o public.gpyb_orders; sub bigint; off_amount bigint:=0; used integer;
begin
 select * into s from public.gpyb_settings where id;
 if not s.sales_enabled then raise exception 'SALES_DISABLED'; end if;
 if p_days<1 or p_days>s.max_days then raise exception 'INVALID_DAYS'; end if;
 select * into customer from public.gpyb_customers where bale_id=p_user;
 if not found or length(trim(customer.first_name))<2 or length(trim(customer.last_name))<2 then raise exception 'NAME_REQUIRED'; end if;
 if p_kind not in ('purchase','renewal') then raise exception 'INVALID_KIND'; end if;
 if p_kind='renewal' and not exists(select 1 from public.gpyb_subscriptions where id=p_subscription and bale_id=p_user) then raise exception 'TOKEN_NOT_OWNED'; end if;
 sub:=s.daily_price_toman::bigint*p_days;
 if p_coupon is not null then
  select * into c from public.gpyb_coupons where code=upper(trim(p_coupon)) for update;
  if not found or not c.active or (c.expires_at is not null and c.expires_at<=now()) then raise exception 'INVALID_COUPON'; end if;
  select count(*) into used from public.gpyb_orders where coupon_id=c.id and (paid_at is not null or status='checkout' or(status='pending' and expires_at>now()));
  if used>=c.max_uses then raise exception 'COUPON_EXHAUSTED'; end if;
  select count(*) into used from public.gpyb_orders where coupon_id=c.id and bale_id=p_user and (paid_at is not null or status='checkout' or(status='pending' and expires_at>now()));
  if used>=c.per_user_limit then raise exception 'COUPON_USER_LIMIT'; end if;
  off_amount:=least(sub-1,case when c.kind='percent' then floor(sub*c.value/100.0)::bigint else c.value::bigint end);
 end if;
 insert into public.gpyb_orders(bale_id,full_name,kind,days,subtotal_toman,discount_toman,total_toman,coupon_id,subscription_id)
 values(p_user,trim(customer.first_name||' '||customer.last_name),p_kind,p_days,sub,off_amount,sub-off_amount,c.id,p_subscription) returning * into o;
 return o;
end; $$;

create function public.gpyb_precheckout(p_order uuid,p_user bigint,p_charge text,p_amount bigint,p_currency text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders;
begin
 select * into o from public.gpyb_orders where id=p_order for update;
 if not found or o.bale_id<>p_user or o.total_toman*10<>p_amount or p_currency<>'IRR'
 or o.status not in ('pending','checkout') or o.expires_at<=now()
 or (o.pre_checkout_id is not null and o.pre_checkout_id<>p_charge) then return false; end if;
 if not exists(select 1 from public.gpyb_settings where id and sales_enabled) then return false; end if;
 update public.gpyb_orders set status='checkout',pre_checkout_id=p_charge where id=p_order;
 return true;
end; $$;

create function public.gpyb_record_payment(p_order uuid,p_user bigint,p_charge text,p_provider text,p_amount bigint,p_currency text)
returns public.gpyb_orders language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders;
begin
 select * into o from public.gpyb_orders where id=p_order for update;
 if not found or o.bale_id<>p_user or o.total_toman*10<>p_amount or p_currency<>'IRR' or length(p_charge)<1
 or(o.pre_checkout_id is not null and o.pre_checkout_id<>p_charge) then raise exception 'PAYMENT_MISMATCH'; end if;
 if o.paid_at is not null then
  if o.charge_id<>p_charge then raise exception 'PAYMENT_MISMATCH'; end if;
  return o;
 end if;
 update public.gpyb_orders set status='paid',paid_at=now(),charge_id=p_charge,provider_charge_id=nullif(p_provider,'') where id=p_order returning * into o;
 insert into public.gpyb_audit(action,actor,detail) values('payment.verified',p_user::text,jsonb_build_object('order_id',p_order,'toman',o.total_toman));
 return o;
end; $$;

create function public.gpyb_bind_token(p_user bigint,p_remote text,p_hash text,p_cipher text,p_expiry timestamptz)
returns public.gpyb_subscriptions language plpgsql security invoker set search_path='' as $$
declare s public.gpyb_subscriptions;
begin
 perform pg_advisory_xact_lock(hashtext('gpyb:token:'||p_hash));
 select * into s from public.gpyb_subscriptions where token_hash=p_hash or remote_id=p_remote for update;
 if found and s.bale_id<>p_user then raise exception 'TOKEN_NOT_OWNED'; end if;
 insert into public.gpyb_subscriptions(bale_id,remote_id,token_hash,token_ciphertext,expires_at)
 values(p_user,p_remote,p_hash,p_cipher,p_expiry)
 on conflict(token_hash) do update set token_ciphertext=excluded.token_ciphertext,expires_at=excluded.expires_at,updated_at=now() returning * into s;
 return s;
end; $$;

create function public.gpyb_complete(p_order uuid,p_remote text,p_hash text,p_cipher text,p_expiry timestamptz)
returns public.gpyb_orders language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders; s public.gpyb_subscriptions;
begin
 select * into o from public.gpyb_orders where id=p_order for update;
 if not found or o.paid_at is null then raise exception 'PAYMENT_REQUIRED'; end if;
 if o.status='fulfilled' then return o; end if;
 select * into s from public.gpyb_bind_token(o.bale_id,p_remote,p_hash,p_cipher,p_expiry);
 update public.gpyb_orders set status='fulfilled',subscription_id=s.id,target_expires_at=p_expiry,fulfilled_at=now(),error_code=null where id=p_order returning * into o;
 insert into public.gpyb_audit(action,actor,detail) values('subscription.fulfilled',o.bale_id::text,jsonb_build_object('order_id',p_order,'kind',o.kind));
 return o;
end; $$;

create function public.gpyb_dashboard() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
  'revenue',coalesce((select sum(total_toman) from public.gpyb_orders where paid_at is not null),0),
  'today_revenue',coalesce((select sum(total_toman) from public.gpyb_orders where (paid_at at time zone 'Asia/Tehran')::date=(now() at time zone 'Asia/Tehran')::date),0),
  'customers',(select count(*) from public.gpyb_customers),
  'active_subscriptions',(select count(*) from public.gpyb_subscriptions where expires_at>now()),
  'orders',(select count(*) from public.gpyb_orders),
  'attention',(select count(*) from public.gpyb_orders where status in ('paid','review','provisioning')),
  'series',(select jsonb_agg(jsonb_build_object('day',d.day,'amount',coalesce((select sum(total_toman) from public.gpyb_orders where (paid_at at time zone 'Asia/Tehran')::date=d.day),0)) order by d.day)
   from(select (now() at time zone 'Asia/Tehran')::date-i as day from generate_series(0,6) i) d)
 ); $$;

-- All data is server-only. Browser clients receive no direct table or RPC privileges.
do $$ declare t text; f record; begin
 for t in select tablename from pg_tables where schemaname='public' and tablename like 'gpyb\_%' escape '\' loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on table public.%I from public,anon,authenticated',t);
  execute format('grant all on table public.%I to service_role',t);
 end loop;
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'gpyb\_%' escape '\' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end; $$;
grant usage,select on sequence public.gpyb_audit_id_seq to service_role;
revoke all on sequence public.gpyb_audit_id_seq from public,anon,authenticated;
