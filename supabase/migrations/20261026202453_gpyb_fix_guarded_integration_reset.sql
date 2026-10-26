-- Keep pg-safeupdate enabled: reset only conversations owned by registered customers.
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
   delete from public.gpyb_conversations where bale_id in (select bale_id from public.gpyb_customers);
  end if;
  update public.gpyb_settings set extension_account_id=p_meta->>'account_id',updated_at=now() where id;
 elsif p_kind='bale_bot' then
  if p_webhook is null or p_meta->>'bot_id' is null then raise exception 'INVALID_INPUT'; end if;
  if s.bot_id is not null and s.bot_id<>(p_meta->>'bot_id')::bigint then
   delete from public.gpyb_secrets where key='bale_payment';
   delete from public.gpyb_conversations where bale_id in (select bale_id from public.gpyb_customers);
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

revoke all on function public.gpyb_save_integration(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.gpyb_save_integration(text,text,text,jsonb) to service_role;
notify pgrst, 'reload schema';
