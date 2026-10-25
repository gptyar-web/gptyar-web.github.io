-- Remove obsolete Rubika runtime objects from already deployed Bale-only projects.
-- Preserve historical orders, customers, payments and audit records.
-- Keep the 20261023 historical migration in source control for migration-history consistency.
do $cleanup$
declare fn record;
begin
 for fn in select p.oid::regprocedure as signature
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'gpyb_rubika_%'
 loop
  execute format('drop function if exists %s',fn.signature);
 end loop;
end $cleanup$;

drop table if exists public.gpyb_rubika_bridges;
drop table if exists public.gpyb_rubika_updates;
drop table if exists public.gpyb_rubika_users;
drop sequence if exists public.gpyb_rubika_identity_seq;
delete from public.gpyb_secrets where key in ('rubika_bot','rubika_webhook');
