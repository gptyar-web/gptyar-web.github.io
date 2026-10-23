-- Optional bank-card transfer for Rubika only; Bale wallet orders retain their own payment checks.
create table if not exists public.gpyb_card_settings (
 id boolean primary key default true check(id),
 card_number text not null check(card_number ~ '^[0-9]{16}$'),
 holder_name text not null check(length(trim(holder_name)) between 5 and 100),
 enabled boolean not null default false,
 updated_at timestamptz not null default now()
);
create table if not exists public.gpyb_card_transfers (
 order_id uuid primary key references public.gpyb_orders(id) on delete cascade,
 virtual_id bigint not null check(virtual_id < 0),
 card_number text not null check(card_number ~ '^[0-9]{16}$'),
 holder_name text not null,
 amount_toman bigint not null check(amount_toman > 0),
 status text not null default 'awaiting' check(status in ('awaiting','submitted','approved','rejected')),
 receipt_ref text,
 submitted_at timestamptz,
 decided_at timestamptz,
 decided_by text,
 created_at timestamptz not null default now(),
 check((status in ('submitted','approved','rejected')) = (receipt_ref is not null))
);
create index if not exists gpyb_card_transfers_status_idx on public.gpyb_card_transfers(status,submitted_at desc);

create or replace function public.gpyb_card_open(p_order uuid,p_user bigint)
returns public.gpyb_card_transfers
language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders; config public.gpyb_card_settings; transfer public.gpyb_card_transfers;
begin
 select * into o from public.gpyb_orders where id=p_order for update;
 if not found or o.bale_id<>p_user or p_user>=0 or o.status<>'pending'
    or o.paid_at is not null or o.total_toman<=0 or o.expires_at<=now()
 then raise exception 'CARD_ORDER_NOT_PAYABLE'; end if;
 select * into transfer from public.gpyb_card_transfers where order_id=p_order;
 if found then return transfer; end if;
 select * into config from public.gpyb_card_settings where id=true and enabled=true;
 if not found then raise exception 'CARD_PAYMENT_UNAVAILABLE'; end if;
 insert into public.gpyb_card_transfers(order_id,virtual_id,card_number,holder_name,amount_toman)
 values(o.id,p_user,config.card_number,config.holder_name,o.total_toman) returning * into transfer;
 -- Give a reasonable period to complete a normal bank transfer.
 update public.gpyb_orders set expires_at=greatest(expires_at,now()+interval '1 day') where id=o.id;
 return transfer;
end $$;

create or replace function public.gpyb_card_submit(p_order uuid,p_user bigint,p_receipt text)
returns public.gpyb_card_transfers
language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders; transfer public.gpyb_card_transfers; info text;
begin
 info:=trim(regexp_replace(coalesce(p_receipt,''),'[[:space:]]+',' ','g'));
 if length(info)<5 or length(info)>160 or info ~ '[[:cntrl:]<>]'
 then raise exception 'INVALID_CARD_RECEIPT'; end if;
 select * into o from public.gpyb_orders where id=p_order for update;
 if not found or o.bale_id<>p_user or p_user>=0 or o.status<>'pending'
    or o.paid_at is not null or o.expires_at<=now()
 then raise exception 'CARD_ORDER_NOT_PAYABLE'; end if;
 select * into transfer from public.gpyb_card_transfers where order_id=p_order for update;
 if not found or transfer.virtual_id<>p_user or transfer.amount_toman<>o.total_toman
    or transfer.status not in ('awaiting','rejected')
 then raise exception 'CARD_RECEIPT_ALREADY_SUBMITTED'; end if;
 update public.gpyb_card_transfers
 set receipt_ref=info,status='submitted',submitted_at=now(),decided_at=null,decided_by=null
 where order_id=p_order returning * into transfer;
 -- Preserve coupon reservations while a human checks the receipt.
 update public.gpyb_orders set expires_at=greatest(expires_at,now()+interval '7 days') where id=p_order;
 insert into public.gpyb_audit(action,actor,detail) values(
  'card.receipt_submitted',p_user::text,jsonb_build_object('order_id',p_order));
 return transfer;
end $$;

create or replace function public.gpyb_card_decide(p_order uuid,p_approve boolean,p_actor text)
returns public.gpyb_orders
language plpgsql security invoker set search_path='' as $$
declare o public.gpyb_orders; transfer public.gpyb_card_transfers;
begin
 if trim(coalesce(p_actor,''))='' then raise exception 'CARD_REVIEW_DENIED'; end if;
 select * into o from public.gpyb_orders where id=p_order for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into transfer from public.gpyb_card_transfers where order_id=p_order for update;
 if not found or transfer.virtual_id<>o.bale_id or transfer.amount_toman<>o.total_toman
 then raise exception 'CARD_REVIEW_DENIED'; end if;
 if transfer.status='approved' and p_approve and o.paid_at is not null then return o; end if;
 if transfer.status<>'submitted' or o.status<>'pending' or o.paid_at is not null
 then raise exception 'CARD_REVIEW_DENIED'; end if;
 if p_approve then
  update public.gpyb_card_transfers set status='approved',decided_at=now(),decided_by=p_actor where order_id=p_order;
  update public.gpyb_orders set status='paid',paid_at=now(),error_code=null where id=p_order returning * into o;
 else
  update public.gpyb_card_transfers set status='rejected',decided_at=now(),decided_by=p_actor where order_id=p_order;
 end if;
 insert into public.gpyb_audit(action,actor,detail) values(
  case when p_approve then 'card.approved' else 'card.rejected' end,p_actor,
  jsonb_build_object('order_id',p_order,'toman',o.total_toman));
 return o;
end $$;

-- This route never changes gpyb_record_payment or the pre-checkout/verification of Bale.
do $permissions$
declare table_name text; f record;
begin
 foreach table_name in array array['gpyb_card_settings','gpyb_card_transfers'] loop
  execute format('alter table public.%I enable row level security',table_name);
  execute format('revoke all on table public.%I from public,anon,authenticated',table_name);
  execute format('grant all on table public.%I to service_role',table_name);
 end loop;
 for f in
  select p.oid::regprocedure as sig from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('gpyb_card_open','gpyb_card_submit','gpyb_card_decide')
 loop
  execute format('revoke all on function %s from public,anon,authenticated',f.sig);
  execute format('grant execute on function %s to service_role',f.sig);
 end loop;
end $permissions$;
