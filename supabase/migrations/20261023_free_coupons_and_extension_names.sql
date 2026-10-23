-- 100% discounts create genuinely free orders, and renewals inherit the subscriber name.
-- Invariants: no fake provider charge, coupon limits remain transactionally enforced, no public RPC access.
alter table public.gpyb_orders drop constraint if exists gpyb_orders_total_toman_check;
alter table public.gpyb_orders add constraint gpyb_orders_total_toman_check check (total_toman >= 0);

create or replace function public.gpyb_new_order_v2(
  p_user bigint,p_days integer,p_kind text,p_coupon text,p_subscription uuid,p_name text
) returns public.gpyb_orders
language plpgsql security invoker set search_path = '' as $$
declare
 s public.gpyb_settings;
 c public.gpyb_coupons;
 customer public.gpyb_customers;
 o public.gpyb_orders;
 sub bigint;
 off_amount bigint := 0;
 used integer;
 display_name text;
begin
 select * into s from public.gpyb_settings where id=true;
 if not found or not s.sales_enabled then raise exception 'SALES_DISABLED'; end if;
 if p_days < 1 or p_days > s.max_days then raise exception 'INVALID_DAYS'; end if;
 if p_kind not in ('purchase','renewal') then raise exception 'INVALID_KIND'; end if;
 select * into customer from public.gpyb_customers where bale_id=p_user;
 if not found then raise exception 'NAME_REQUIRED'; end if;

 if p_kind='renewal' then
  if p_subscription is null or not exists(
    select 1 from public.gpyb_subscriptions where id=p_subscription and bale_id=p_user
  ) then raise exception 'TOKEN_NOT_OWNED'; end if;
  display_name := trim(regexp_replace(coalesce(p_name,''),'\s+',' ','g'));
  if length(display_name)<2 or length(display_name)>160 or display_name ~ '[<>[:cntrl:]]'
  then raise exception 'EXTENSION_SUBSCRIBER_NAME'; end if;
 else
  if p_subscription is not null or p_name is not null then raise exception 'INVALID_INPUT'; end if;
  if length(trim(customer.first_name))<2 or length(trim(customer.last_name))<2
  then raise exception 'NAME_REQUIRED'; end if;
  display_name:=trim(customer.first_name||' '||customer.last_name);
 end if;

 sub:=s.daily_price_toman::bigint * p_days;
 if p_coupon is not null then
  select * into c from public.gpyb_coupons where code=upper(trim(p_coupon)) for update;
  if not found or not c.active or (c.expires_at is not null and c.expires_at<=now())
  then raise exception 'INVALID_COUPON'; end if;

  select count(*) into used from public.gpyb_orders where coupon_id=c.id
    and (paid_at is not null or status='checkout' or (status='pending' and expires_at>now()));
  if used>=c.max_uses then raise exception 'COUPON_EXHAUSTED'; end if;

  select count(*) into used from public.gpyb_orders where coupon_id=c.id and bale_id=p_user
    and (paid_at is not null or status='checkout' or (status='pending' and expires_at>now()));
  if used>=c.per_user_limit then raise exception 'COUPON_USER_LIMIT'; end if;

  off_amount:=least(sub,case when c.kind='percent' then floor(sub*c.value/100.0)::bigint else c.value::bigint end);
 end if;

 insert into public.gpyb_orders(
  bale_id,full_name,kind,days,subtotal_toman,discount_toman,total_toman,coupon_id,subscription_id,status,paid_at
 ) values (
  p_user,display_name,p_kind,p_days,sub,off_amount,sub-off_amount,c.id,p_subscription,
  case when off_amount=sub then 'paid' else 'pending' end,
  case when off_amount=sub then now() else null end
 ) returning * into o;

 if o.total_toman=0 then
  insert into public.gpyb_audit(action,actor,detail)
  values('coupon.redeemed',p_user::text,jsonb_build_object('order_id',o.id,'coupon_id',c.id,'discount_toman',off_amount,'payment_required',false));
 end if;
 return o;
end; $$;

revoke all on function public.gpyb_new_order_v2(bigint,integer,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.gpyb_new_order_v2(bigint,integer,text,text,uuid,text) to service_role;
