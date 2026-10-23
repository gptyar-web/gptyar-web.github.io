-- Additive upgrade. Existing users, orders, secrets and other applications are preserved.
alter table public.gpyb_orders add column if not exists remote_id text;
alter table public.gpyb_orders add column if not exists request_key text;
alter table public.gpyb_orders add column if not exists creation_known_ids text[];
alter table public.gpyb_orders add column if not exists delivery_sent_at timestamptz;
alter table public.gpyb_orders add column if not exists delivery_error_code text;
create unique index if not exists gpyb_orders_request_idx on public.gpyb_orders(bale_id,request_key) where request_key is not null;
create unique index if not exists gpyb_orders_created_remote_idx on public.gpyb_orders(remote_id) where kind='purchase' and remote_id is not null;

-- A retried webhook redeems a coupon and creates its order only once.
create or replace function public.gpyb_checkout_order(
 p_user bigint,p_days integer,p_kind text,p_coupon text,p_subscription uuid,p_name text,p_request text
) returns public.gpyb_orders language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders;
begin
 perform pg_advisory_xact_lock(hashtext('gpyb:checkout:'||p_user::text));
 if p_request is not null then
  if length(p_request)>80 then raise exception 'INVALID_INPUT'; end if;
  select * into o from public.gpyb_orders where bale_id=p_user and request_key=p_request;
  if found then return o; end if;
 end if;
 select * into o from public.gpyb_new_order_v2(p_user,p_days,p_kind,p_coupon,p_subscription,p_name);
 update public.gpyb_orders set request_key=p_request where id=o.id returning * into o;
 return o;
end; $$;

-- Rotate a subscriber's token without conflicting with the unique remote identifier.
create or replace function public.gpyb_bind_token(p_user bigint,p_remote text,p_hash text,p_cipher text,p_expiry timestamptz)
returns public.gpyb_subscriptions language plpgsql security invoker set search_path='' as $$
declare s public.gpyb_subscriptions;
begin
 if p_remote is null or length(p_remote)=0 or p_hash is null or p_cipher is null then raise exception 'INVALID_USER_TOKEN'; end if;
 perform pg_advisory_xact_lock(hashtext('gpyb:remote:'||p_remote));
 perform pg_advisory_xact_lock(hashtext('gpyb:token:'||p_hash));
 select * into s from public.gpyb_subscriptions where remote_id=p_remote for update;
 if found and s.bale_id<>p_user then raise exception 'TOKEN_NOT_OWNED'; end if;
 if exists(select 1 from public.gpyb_subscriptions where token_hash=p_hash and remote_id<>p_remote)
 then raise exception 'TOKEN_NOT_OWNED'; end if;
 insert into public.gpyb_subscriptions(bale_id,remote_id,token_hash,token_ciphertext,expires_at)
 values(p_user,p_remote,p_hash,p_cipher,p_expiry)
 on conflict(remote_id) do update set token_hash=excluded.token_hash,token_ciphertext=excluded.token_ciphertext,
 expires_at=excluded.expires_at,updated_at=now() returning * into s;
 return s;
end; $$;

create or replace function public.gpyb_select_subscription(p_order uuid,p_user bigint,p_subscription uuid,p_name text)
returns public.gpyb_orders language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders;
begin
 select * into o from public.gpyb_orders where id=p_order and bale_id=p_user for update;
 if not found or o.paid_at is null then raise exception 'PAYMENT_REQUIRED'; end if;
 if o.status<>'paid' or o.remote_id is not null or o.target_expires_at is not null
 then raise exception 'RECONCILIATION_REQUIRED'; end if;
 if not exists(select 1 from public.gpyb_subscriptions where id=p_subscription and bale_id=p_user)
 then raise exception 'TOKEN_NOT_OWNED'; end if;
 if p_name is null or length(trim(p_name))<2 or length(p_name)>160 then raise exception 'EXTENSION_SUBSCRIBER_NAME'; end if;
 update public.gpyb_orders set subscription_id=p_subscription,kind='renewal',full_name=p_name
 where id=p_order returning * into o;
 return o;
end; $$;

-- Changing a password and invalidating sessions are one transaction.
create or replace function public.gpyb_change_password(p_admin uuid,p_expected text,p_password text,p_counter bigint)
returns boolean language plpgsql security invoker set search_path='' as $$
declare a public.gpyb_admins;
begin
 select * into a from public.gpyb_admins where id=p_admin and active for update;
 if not found or a.password_hash<>p_expected then raise exception 'AUTH_DENIED'; end if;
 if p_counter is null or p_counter<=a.last_totp_counter then raise exception 'OTP_REPLAY'; end if;
 update public.gpyb_admins set password_hash=p_password,last_totp_counter=p_counter where id=a.id;
 update public.gpyb_sessions set expires_at=least(expires_at,now()) where admin_id=a.id;
 insert into public.gpyb_audit(action,actor) values('auth.password_changed',a.username);
 return true;
end; $$;

-- Enrollment must not activate the admin without saving the recovery codes.
create or replace function public.gpyb_enroll_auth(p_challenge text,p_counter bigint,p_next text,p_codes text[])
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 perform pg_advisory_xact_lock(hashtext('gpyb:setup'));
 if cardinality(p_codes) is distinct from 8 or exists(select 1 from unnest(p_codes) c where c is null or c !~ '^[a-f0-9]{64}$')
 then raise exception 'INVALID_INPUT'; end if;
 if not exists(select 1 from public.gpyb_sessions where token_hash=p_challenge and stage='setup')
 then raise exception 'CHALLENGE_EXPIRED'; end if;
 result:=public.gpyb_finish_auth(p_challenge,p_counter,p_next,null);
 insert into public.gpyb_recovery_codes(admin_id,code_hash) select (result->>'id')::uuid,c from unnest(p_codes) c;
 return result;
end; $$;

-- Secrets and their account metadata must change together.
create or replace function public.gpyb_save_integration(p_kind text,p_cipher text,p_webhook text,p_meta jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare s public.gpyb_settings;
begin
 select * into s from public.gpyb_settings where id=true for update;
 if p_kind not in ('bale_bot','bale_payment','extension_admin') or p_cipher is null or length(p_cipher)=0
 then raise exception 'INVALID_INPUT'; end if;
 if p_kind='extension_admin' then
  if coalesce(p_meta->>'account_id','')='' then raise exception 'INVALID_INPUT'; end if;
  if s.extension_account_id is not null and s.extension_account_id<>p_meta->>'account_id'
   and (exists(select 1 from public.gpyb_subscriptions) or exists(select 1 from public.gpyb_orders where paid_at is not null or status in ('pending','checkout')))
  then raise exception 'EXTENSION_ACCOUNT_LOCKED'; end if;
  update public.gpyb_settings set extension_account_id=p_meta->>'account_id',updated_at=now() where id=true;
 elsif p_kind='bale_bot' then
  if p_webhook is null or p_meta->>'bot_id' is null then raise exception 'INVALID_INPUT'; end if;
  if s.bot_id is not null and s.bot_id<>(p_meta->>'bot_id')::bigint
   and exists(select 1 from public.gpyb_orders where paid_at is not null or status in ('pending','checkout'))
  then raise exception 'BOT_ACCOUNT_LOCKED'; end if;
  insert into public.gpyb_secrets(key,ciphertext) values('webhook',p_webhook)
   on conflict(key) do update set ciphertext=excluded.ciphertext,updated_at=now();
  update public.gpyb_settings set bot_username=p_meta->>'username',bot_id=(p_meta->>'bot_id')::bigint,connected_at=now(),updated_at=now() where id=true;
 end if;
 insert into public.gpyb_secrets(key,ciphertext) values(p_kind,p_cipher)
  on conflict(key) do update set ciphertext=excluded.ciphertext,updated_at=now();
 return true;
end; $$;

-- Aggregate in SQL, rather than truncating usage at the REST API row limit.
create or replace function public.gpyb_coupon_report(p_page integer default 1) returns jsonb
language sql stable security invoker set search_path='' as $$
 with page as (select c.* from public.gpyb_coupons c order by c.created_at desc,c.id limit 26 offset (greatest(1,p_page)-1)*25),
 report as (select c.*, (select count(*) from public.gpyb_orders o where o.coupon_id=c.id and o.paid_at is not null) used,
  (select count(*) from public.gpyb_orders o where o.coupon_id=c.id and o.paid_at is null and (o.status='checkout' or (o.status='pending' and o.expires_at>now()))) reserved from page c)
 select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id),'[]'::jsonb)) from report r;
$$;

-- Preserve custom authentication: no browser or public RPC access.
revoke all on function public.gpyb_checkout_order(bigint,integer,text,text,uuid,text,text) from public,anon,authenticated;
revoke all on function public.gpyb_bind_token(bigint,text,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.gpyb_select_subscription(uuid,bigint,uuid,text) from public,anon,authenticated;
revoke all on function public.gpyb_change_password(uuid,text,text,bigint) from public,anon,authenticated;
revoke all on function public.gpyb_enroll_auth(text,bigint,text,text[]) from public,anon,authenticated;
revoke all on function public.gpyb_save_integration(text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.gpyb_coupon_report(integer) from public,anon,authenticated;
grant execute on function public.gpyb_checkout_order(bigint,integer,text,text,uuid,text,text) to service_role;
grant execute on function public.gpyb_bind_token(bigint,text,text,text,timestamptz) to service_role;
grant execute on function public.gpyb_select_subscription(uuid,bigint,uuid,text) to service_role;
grant execute on function public.gpyb_change_password(uuid,text,text,bigint) to service_role;
grant execute on function public.gpyb_enroll_auth(text,bigint,text,text[]) to service_role;
grant execute on function public.gpyb_save_integration(text,text,text,jsonb) to service_role;
grant execute on function public.gpyb_coupon_report(integer) to service_role;

create or replace function public.gpyb_record_payment(p_order uuid,p_user bigint,p_charge text,p_provider text,p_amount bigint,p_currency text)
returns public.gpyb_orders language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders;
begin
 select * into o from public.gpyb_orders where id=p_order for update;
 if not found or p_user is null or p_amount is null or p_amount<=0 or o.bale_id<>p_user or o.total_toman*10<>p_amount or p_currency is distinct from 'IRR' or p_charge is null or length(p_charge)<1 or length(p_charge)>128
 or(o.pre_checkout_id is not null and o.pre_checkout_id<>p_charge) then raise exception 'PAYMENT_MISMATCH'; end if;
 if o.paid_at is not null then
  if o.charge_id is distinct from p_charge then raise exception 'PAYMENT_MISMATCH'; end if;
  return o;
 end if;
 update public.gpyb_orders set status='paid',paid_at=now(),charge_id=p_charge,provider_charge_id=nullif(p_provider,'') where id=p_order returning * into o;
 insert into public.gpyb_audit(action,actor,detail) values('payment.verified',p_user::text,jsonb_build_object('order_id',p_order,'toman',o.total_toman));
 return o;
end; $$;


create or replace function public.gpyb_claim_update(p_id bigint,p_owner uuid) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 insert into public.gpyb_updates as u(update_id,owner,locked_until) values(p_id,p_owner,now()+interval '180 seconds')
 on conflict(update_id) do update set status='processing',owner=p_owner,locked_until=excluded.locked_until
 where u.status='error' or (u.status='processing' and u.locked_until<now());
 get diagnostics n=row_count; return n=1;
end; $$;


notify pgrst, 'reload schema';
