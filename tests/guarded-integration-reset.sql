-- Run through psql against an isolated installation with pg-safeupdate available.
-- The transaction rolls back credentials, settings and fixture rows.
begin;
load 'safeupdate';
set local safeupdate.enabled=on;
set local role service_role;
do $test$
declare customer_id bigint; initial_orders bigint; initial_subscriptions bigint;
begin
 select coalesce(min(bale_id),0)-1 into customer_id from public.gpyb_customers;
 insert into public.gpyb_customers(bale_id,first_name,last_name) values(customer_id,'Guard','Test');
 insert into public.gpyb_conversations(bale_id,state,data) values(customer_id,'await_payment','{"order_id":"test"}');
 select count(*) into initial_orders from public.gpyb_orders;
 select count(*) into initial_subscriptions from public.gpyb_subscriptions;
 update public.gpyb_settings set bot_id=101,extension_account_id='guard-old',sales_enabled=true where id;
 perform public.gpyb_save_integration('bale_bot','test-cipher','test-webhook','{"bot_id":102,"username":"guard_test"}');
 if exists(select 1 from public.gpyb_conversations where bale_id=customer_id)
 then raise exception 'BOT_CONVERSATION_NOT_RESET'; end if;
 insert into public.gpyb_conversations(bale_id,state) values(customer_id,'paid_choice');
 perform public.gpyb_save_integration('extension_admin','test-manager',null,'{"account_id":"guard-new"}');
 if exists(select 1 from public.gpyb_conversations where bale_id=customer_id)
 then raise exception 'EXTENSION_CONVERSATION_NOT_RESET'; end if;
 -- Replacing credentials for the same account preserves conversation state.
 insert into public.gpyb_conversations(bale_id,state) values(customer_id,'menu');
 perform public.gpyb_save_integration('bale_bot','rotated-cipher','same-webhook','{"bot_id":102}');
 if not exists(select 1 from public.gpyb_conversations where bale_id=customer_id)
 then raise exception 'SAME_BOT_CONVERSATION_WAS_RESET'; end if;
 if (select count(*) from public.gpyb_orders)<>initial_orders or (select count(*) from public.gpyb_subscriptions)<>initial_subscriptions
 then raise exception 'COMMERCE_HISTORY_CHANGED'; end if;
end;
$test$;
rollback;
select 'Credential replacement assertions passed; all changes rolled back.' as verification;
