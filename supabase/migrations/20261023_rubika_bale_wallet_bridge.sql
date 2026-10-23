-- Additive, server-only Rubika identity and Bale-wallet handoff.
-- Existing Bale IDs remain strictly positive. Synthetic Rubika IDs are negative.
create sequence if not exists public.gpyb_rubika_identity_seq
  as bigint start with -1000000001 increment by -1 minvalue -9007199254740991 maxvalue -1 no cycle;
create table if not exists public.gpyb_rubika_users (
 rubika_id text primary key check(rubika_id ~ '^u[A-Za-z0-9]{4,80}$'),
 virtual_id bigint not null unique default nextval('public.gpyb_rubika_identity_seq'),
 seen_at timestamptz not null default now(), check(virtual_id < 0)
);
create table if not exists public.gpyb_rubika_updates (
 event_id text primary key,
 owner uuid not null,
 status text not null default 'processing' check(status in ('processing','done','error')),
 locked_until timestamptz not null default now()+interval '3 minutes'
);
create table if not exists public.gpyb_rubika_bridges (
 order_id uuid primary key references public.gpyb_orders(id) on delete cascade,
 virtual_id bigint not null,
 nonce_hash text not null unique check(nonce_hash ~ '^[a-f0-9]{64}$'),
 bale_user_id bigint,
 state text not null default 'issued' check(state in ('issued','claimed','paid')),
 expires_at timestamptz not null,
 created_at timestamptz not null default now(),
 check(bale_user_id is null or bale_user_id>0),
 check(virtual_id<0),
 check(state='issued' or bale_user_id is not null)
);
create index if not exists gpyb_rubika_bridges_bale_idx on public.gpyb_rubika_bridges(bale_user_id);
create unique index if not exists gpyb_orders_charge_unique on public.gpyb_orders(charge_id) where charge_id is not null;

create or replace function public.gpyb_rubika_identity(p_user text) returns bigint
language plpgsql security invoker set search_path='' as $$
declare v bigint;
begin
 if p_user !~ '^u[A-Za-z0-9]{4,80}$' then raise exception 'INVALID_RUBIKA_USER'; end if;
 insert into public.gpyb_rubika_users(rubika_id) values(p_user)
 on conflict(rubika_id) do update set seen_at=now() returning virtual_id into v;
 return v;
end $$;

create or replace function public.gpyb_rubika_claim_update(p_event text,p_owner uuid) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 if length(p_event)>260 or p_event !~ '^rubika:u[A-Za-z0-9]+:[a-zA-Z0-9_-]+$'
 then raise exception 'INVALID_RUBIKA_UPDATE'; end if;
 insert into public.gpyb_rubika_updates as r(event_id,owner,status,locked_until)
 values(p_event,p_owner,'processing',now()+interval '3 minutes')
 on conflict(event_id) do update set owner=excluded.owner,status='processing',
 locked_until=excluded.locked_until
 where r.status='error' or (r.status='processing' and r.locked_until<now());
 get diagnostics n=row_count;
 return n=1;
end $$;

create or replace function public.gpyb_rubika_bridge_issue(p_order uuid,p_virtual bigint,p_hash text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders; r uuid;
begin
 if p_hash !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_BRIDGE'; end if;
 select * into o from public.gpyb_orders where id=p_order for update;
 if not found or o.bale_id<>p_virtual or p_virtual>=0 or o.status<>'pending'
 or o.paid_at is not null or o.expires_at<=now() or o.total_toman<=0
 then raise exception 'BRIDGE_NOT_PAYABLE'; end if;
 insert into public.gpyb_rubika_bridges as b(order_id,virtual_id,nonce_hash,expires_at)
 values(p_order,p_virtual,p_hash,o.expires_at)
 on conflict(order_id) do update set nonce_hash=excluded.nonce_hash,expires_at=excluded.expires_at
 where b.state='issued' and b.bale_user_id is null
 returning order_id into r;
 if r is null then raise exception 'BRIDGE_ALREADY_CLAIMED'; end if;
 return r;
end $$;

create or replace function public.gpyb_rubika_bridge_claim(p_hash text,p_bale bigint)
returns public.gpyb_orders language plpgsql security invoker set search_path='' as $$
declare b public.gpyb_rubika_bridges; o public.gpyb_orders;
begin
 if p_hash !~ '^[a-f0-9]{64}$' or p_bale<=0 then raise exception 'BRIDGE_INVALID'; end if;
 select * into b from public.gpyb_rubika_bridges where nonce_hash=p_hash for update;
 if not found or b.expires_at<=now() or (b.bale_user_id is not null and b.bale_user_id<>p_bale)
 then raise exception 'BRIDGE_INVALID'; end if;
 select * into o from public.gpyb_orders where id=b.order_id for update;
 if not found or o.bale_id<>b.virtual_id or o.total_toman<=0 or o.status not in ('pending','checkout')
 or o.expires_at<=now() or o.paid_at is not null then raise exception 'BRIDGE_NOT_PAYABLE'; end if;
 update public.gpyb_rubika_bridges set state='claimed',bale_user_id=p_bale where order_id=b.order_id;
 return o;
end $$;

create or replace function public.gpyb_rubika_bridge_precheckout(
 p_order uuid,p_bale bigint,p_charge text,p_amount bigint,p_currency text
) returns boolean language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders; b public.gpyb_rubika_bridges;
begin
 select * into o from public.gpyb_orders where id=p_order for update;
 if not found then return false; end if;
 select * into b from public.gpyb_rubika_bridges where order_id=p_order for update;
 if not found or b.state<>'claimed' or b.bale_user_id<>p_bale or o.bale_id<>b.virtual_id
 or o.status not in ('pending','checkout') or o.expires_at<=now() or b.expires_at<=now()
 or o.paid_at is not null or o.total_toman<=0 or o.total_toman*10<>p_amount
 or p_currency<>'IRR' or length(p_charge)>128 or length(p_charge)<1
 or (o.pre_checkout_id is not null and o.pre_checkout_id<>p_charge)
 then return false; end if;
 if not exists(select 1 from public.gpyb_settings where id and sales_enabled) then return false; end if;
 update public.gpyb_orders set status='checkout',pre_checkout_id=p_charge where id=p_order;
 return true;
end $$;

create or replace function public.gpyb_rubika_bridge_record(
 p_order uuid,p_bale bigint,p_charge text,p_provider text,p_amount bigint,p_currency text
) returns public.gpyb_orders language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders; b public.gpyb_rubika_bridges;
begin
 select * into o from public.gpyb_orders where id=p_order for update;
 if not found then raise exception 'PAYMENT_MISMATCH'; end if;
 select * into b from public.gpyb_rubika_bridges where order_id=p_order for update;
 if not found or b.bale_user_id<>p_bale or b.state not in ('claimed','paid')
 or o.bale_id<>b.virtual_id or p_currency<>'IRR' or p_amount<>o.total_toman*10
 or o.total_toman<=0 or p_charge is null or length(p_charge)<1
 or o.pre_checkout_id<>p_charge then raise exception 'PAYMENT_MISMATCH'; end if;
 if o.paid_at is not null then
  if o.charge_id<>p_charge or b.state<>'paid' then raise exception 'PAYMENT_MISMATCH'; end if;
  return o;
 end if;
 if o.status<>'checkout' then raise exception 'PAYMENT_MISMATCH'; end if;
 update public.gpyb_orders set status='paid',paid_at=now(),charge_id=p_charge,
 provider_charge_id=nullif(p_provider,'') where id=p_order returning * into o;
 update public.gpyb_rubika_bridges set state='paid' where order_id=p_order;
 insert into public.gpyb_audit(action,actor,detail) values(
 'payment.rubika_via_bale',p_bale::text,
 jsonb_build_object('order_id',p_order,'virtual_id',b.virtual_id,'toman',o.total_toman));
 return o;
end $$;

-- Sensitive tables and RPCs remain accessible only to the service-role backend.
do $secure$ declare tab text; fn record;
begin
 foreach tab in array array['gpyb_rubika_users','gpyb_rubika_updates','gpyb_rubika_bridges'] loop
  execute format('alter table public.%I enable row level security',tab);
  execute format('revoke all on table public.%I from public, anon, authenticated',tab);
  execute format('grant all on table public.%I to service_role',tab);
 end loop;
 for fn in select p.oid::regprocedure as signature from pg_proc p
 join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
 'gpyb_rubika_identity','gpyb_rubika_claim_update','gpyb_rubika_bridge_issue',
 'gpyb_rubika_bridge_claim','gpyb_rubika_bridge_precheckout','gpyb_rubika_bridge_record') loop
  execute format('revoke all on function %s from public, anon, authenticated',fn.signature);
  execute format('grant execute on function %s to service_role',fn.signature);
 end loop;
end $secure$;
revoke all on sequence public.gpyb_rubika_identity_seq from public, anon, authenticated;
grant usage,select on sequence public.gpyb_rubika_identity_seq to service_role;
