-- Replace credentials without losing orders or confusing identities across accounts.
alter table public.gpyb_orders add column if not exists extension_account_id text not null default '';
alter table public.gpyb_orders add column if not exists bot_id bigint not null default 0;
alter table public.gpyb_subscriptions add column if not exists extension_account_id text not null default '';
update public.gpyb_orders set extension_account_id=coalesce((select extension_account_id from public.gpyb_settings where id),''),
 bot_id=coalesce((select bot_id from public.gpyb_settings where id),0) where extension_account_id='';
update public.gpyb_subscriptions set extension_account_id=coalesce((select extension_account_id from public.gpyb_settings where id),'') where extension_account_id='';
alter table public.gpyb_subscriptions drop constraint if exists gpyb_subscriptions_remote_id_key;
create unique index if not exists gpyb_subscriptions_account_remote_idx on public.gpyb_subscriptions(extension_account_id,remote_id);
drop index if exists public.gpyb_orders_created_remote_idx;
create unique index gpyb_orders_created_remote_idx on public.gpyb_orders(extension_account_id,remote_id) where kind='purchase' and remote_id is not null;

create or replace function public.gpyb_stamp_integration_scope() returns trigger
language plpgsql security invoker set search_path='' as $$
declare s public.gpyb_settings;
begin
 select * into s from public.gpyb_settings where id;
 if tg_op='INSERT' then
  new.extension_account_id:=coalesce(s.extension_account_id,'');
  if tg_table_name='gpyb_orders' then new.bot_id:=coalesce(s.bot_id,0); end if;
 end if;
 if tg_table_name='gpyb_orders' then
  if tg_op='UPDATE' and new.status in ('provisioning','fulfilled') and new.extension_account_id<>coalesce(s.extension_account_id,'') then raise exception 'EXTENSION_SCOPE'; end if;
  if new.subscription_id is not null and not exists(select 1 from public.gpyb_subscriptions
   where id=new.subscription_id and extension_account_id=new.extension_account_id)
  then raise exception 'EXTENSION_SCOPE'; end if;
 end if;
 return new;
end; $$;
drop trigger if exists gpyb_order_integration_scope on public.gpyb_orders;
create trigger gpyb_order_integration_scope before insert or update of status,subscription_id on public.gpyb_orders
 for each row execute function public.gpyb_stamp_integration_scope();
drop trigger if exists gpyb_subscription_integration_scope on public.gpyb_subscriptions;
create trigger gpyb_subscription_integration_scope before insert on public.gpyb_subscriptions
 for each row execute function public.gpyb_stamp_integration_scope();

create or replace function public.gpyb_bind_token(p_user bigint,p_remote text,p_hash text,p_cipher text,p_expiry timestamptz)
returns public.gpyb_subscriptions language plpgsql security invoker set search_path='' as $$
declare s public.gpyb_subscriptions; account text;
begin
 if p_remote is null or length(p_remote)=0 or p_hash is null or p_cipher is null then raise exception 'INVALID_USER_TOKEN'; end if;
 select coalesce(extension_account_id,'') into account from public.gpyb_settings where id;
 perform pg_advisory_xact_lock(hashtext('gpyb:remote:'||account||':'||p_remote));
 perform pg_advisory_xact_lock(hashtext('gpyb:token:'||p_hash));
 select * into s from public.gpyb_subscriptions where extension_account_id=account and remote_id=p_remote for update;
 if found and s.bale_id<>p_user then raise exception 'TOKEN_NOT_OWNED'; end if;
 if exists(select 1 from public.gpyb_subscriptions where token_hash=p_hash and (remote_id<>p_remote or extension_account_id<>account))
 then raise exception 'TOKEN_NOT_OWNED'; end if;
 insert into public.gpyb_subscriptions(bale_id,remote_id,token_hash,token_ciphertext,expires_at,extension_account_id)
 values(p_user,p_remote,p_hash,p_cipher,p_expiry,account)
 on conflict(extension_account_id,remote_id) do update set token_hash=excluded.token_hash,token_ciphertext=excluded.token_ciphertext,
 expires_at=excluded.expires_at,updated_at=now() returning * into s;
 return s;
end; $$;

create or replace function public.gpyb_complete(p_order uuid,p_remote text,p_hash text,p_cipher text,p_expiry timestamptz)
returns public.gpyb_orders language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders; s public.gpyb_subscriptions;
begin
 select * into o from public.gpyb_orders where id=p_order for update;
 if not found or o.paid_at is null then raise exception 'PAYMENT_REQUIRED'; end if;
 if o.status='fulfilled' then return o; end if;
 if o.extension_account_id<>coalesce((select extension_account_id from public.gpyb_settings where id),'') then raise exception 'EXTENSION_SCOPE'; end if;
 select * into s from public.gpyb_bind_token(o.bale_id,p_remote,p_hash,p_cipher,p_expiry);
 update public.gpyb_orders set status='fulfilled',subscription_id=s.id,target_expires_at=p_expiry,fulfilled_at=now(),error_code=null where id=p_order returning * into o;
 insert into public.gpyb_audit(action,actor,detail) values('subscription.fulfilled',o.bale_id::text,jsonb_build_object('order_id',p_order,'kind',o.kind));
 return o;
end; $$;

create or replace function public.gpyb_precheckout(p_order uuid,p_user bigint,p_charge text,p_amount bigint,p_currency text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders; s public.gpyb_settings;
begin
 select * into o from public.gpyb_orders where id=p_order for update;
 if not found or o.bale_id<>p_user or o.total_toman*10<>p_amount or p_currency is distinct from 'IRR'
 or o.status not in ('pending','checkout') or o.expires_at<=now()
 or (o.pre_checkout_id is not null and o.pre_checkout_id<>p_charge) then return false; end if;
 select * into s from public.gpyb_settings where id;
 if not s.sales_enabled or o.bot_id<>coalesce(s.bot_id,0) or o.extension_account_id<>coalesce(s.extension_account_id,'') then return false; end if;
 update public.gpyb_orders set status='checkout',pre_checkout_id=p_charge where id=p_order;
 return true;
end; $$;

-- Update identifiers restart independently for each bot.
alter table public.gpyb_updates add column if not exists bot_id bigint not null default 0;
update public.gpyb_updates set bot_id=coalesce((select bot_id from public.gpyb_settings where id),0) where bot_id=0;
alter table public.gpyb_updates drop constraint if exists gpyb_updates_pkey;
alter table public.gpyb_updates add primary key(bot_id,update_id);
create or replace function public.gpyb_claim_bot_update(p_bot bigint,p_id bigint,p_owner uuid) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 if p_bot is null or p_id is null or p_id<0 or p_owner is null then raise exception 'INVALID_UPDATE'; end if;
 if p_bot<>0 and not exists(select 1 from public.gpyb_settings where id and bot_id=p_bot) then raise exception 'WEBHOOK_DENIED'; end if;
 insert into public.gpyb_updates as u(bot_id,update_id,owner,locked_until) values(p_bot,p_id,p_owner,now()+interval '180 seconds')
 on conflict(bot_id,update_id) do update set status='processing',owner=p_owner,locked_until=excluded.locked_until
 where u.status='error' or (u.status='processing' and u.locked_until<now());
 get diagnostics n=row_count; return n=1;
end; $$;
create or replace function public.gpyb_claim_update(p_id bigint,p_owner uuid) returns boolean
language sql security invoker set search_path='' as $$
 select public.gpyb_claim_bot_update(coalesce((select bot_id from public.gpyb_settings where id),0),p_id,p_owner);
$$;

create or replace function public.gpyb_save_integration(p_kind text,p_cipher text,p_webhook text,p_meta jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare s public.gpyb_settings;
begin
 select * into s from public.gpyb_settings where id=true for update;
 if p_kind not in ('bale_bot','bale_payment','extension_admin') or p_cipher is null or length(p_cipher)=0 then raise exception 'INVALID_INPUT'; end if;
 if p_kind='extension_admin' then
  if coalesce(p_meta->>'account_id','')='' then raise exception 'INVALID_INPUT'; end if;
  if s.extension_account_id is not null and s.extension_account_id<>p_meta->>'account_id' then
   update public.gpyb_settings set sales_enabled=false where id;
   delete from public.gpyb_conversations;
  end if;
  update public.gpyb_settings set extension_account_id=p_meta->>'account_id',updated_at=now() where id;
 elsif p_kind='bale_bot' then
  if p_webhook is null or p_meta->>'bot_id' is null then raise exception 'INVALID_INPUT'; end if;
  if s.bot_id is not null and s.bot_id<>(p_meta->>'bot_id')::bigint then
   delete from public.gpyb_secrets where key='bale_payment';
   delete from public.gpyb_conversations;
   update public.gpyb_settings set sales_enabled=false where id;
  end if;
  insert into public.gpyb_secrets(key,ciphertext) values('webhook',p_webhook)
   on conflict(key) do update set ciphertext=excluded.ciphertext,updated_at=now();
  update public.gpyb_settings set bot_username=p_meta->>'username',bot_id=(p_meta->>'bot_id')::bigint,connected_at=now(),updated_at=now() where id;
 end if;
 insert into public.gpyb_secrets(key,ciphertext) values(p_kind,p_cipher)
  on conflict(key) do update set ciphertext=excluded.ciphertext,updated_at=now();
 return true;
end; $$;

-- Remove retired credentials and RPCs; archive identity records without exposing them.
delete from public.gpyb_secrets where key in ('rubika_bot','rubika_webhook');
do $$ declare f record; tab text; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and left(p.proname,12)='gpyb_rubika_' loop
  execute format('drop function %s',f.signature);
 end loop;
 foreach tab in array array['gpyb_rubika_users','gpyb_rubika_updates','gpyb_rubika_bridges'] loop
  if to_regclass('public.'||tab) is not null then execute format('revoke all on table public.%I from public,anon,authenticated,service_role',tab); end if;
 end loop;
 if to_regclass('public.gpyb_rubika_identity_seq') is not null then
  revoke all on sequence public.gpyb_rubika_identity_seq from public,anon,authenticated,service_role;
 end if;
end; $$;

revoke all on function public.gpyb_stamp_integration_scope(),public.gpyb_bind_token(bigint,text,text,text,timestamptz),
 public.gpyb_complete(uuid,text,text,text,timestamptz),public.gpyb_precheckout(uuid,bigint,text,bigint,text),
 public.gpyb_claim_bot_update(bigint,bigint,uuid),public.gpyb_claim_update(bigint,uuid),public.gpyb_save_integration(text,text,text,jsonb)
 from public,anon,authenticated;
grant execute on function public.gpyb_stamp_integration_scope(),public.gpyb_bind_token(bigint,text,text,text,timestamptz),
 public.gpyb_complete(uuid,text,text,text,timestamptz),public.gpyb_precheckout(uuid,bigint,text,bigint,text),
 public.gpyb_claim_bot_update(bigint,bigint,uuid),public.gpyb_claim_update(bigint,uuid),public.gpyb_save_integration(text,text,text,jsonb)
 to service_role;

notify pgrst, 'reload schema';
