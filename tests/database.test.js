import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

// Real Postgres/PLpgSQL, isolated in memory. Never runs against customers' data.
test('Postgres checkout, ownership and authentication invariants',async t=>{
 const db=new PGlite();
 const query=async(sql,p=[]) => (await db.query(sql,p)).rows;
 const row=async(sql,p=[]) => (await query(sql,p))[0];
 const fixture=async()=>{
  await db.exec("update public.gpyb_settings set sales_enabled=true; insert into public.gpyb_customers(bale_id,first_name,last_name) values(101,'آزمایش','اول'),(102,'آزمایش','دوم');");
 };
 async function scenario(title,fn){await t.test(title,async()=>{await db.exec('begin');try{await fixture();await fn();}finally{await db.exec('rollback');}});}
 try{
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(await readFile(new URL('../supabase/schema.sql',import.meta.url),'utf8'));
  // Upgrades must also remain safe to reapply after the consolidated fresh schema.
  for(const name of ['20261023_free_coupons_and_extension_names.sql','20261023_reliable_checkout_and_recovery.sql','20261026200939_gpyb_replace_integration_tokens_remove_legacy_messaging.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  await scenario('free checkout is idempotent and consumes exactly one coupon use',async()=>{
   await db.exec("insert into public.gpyb_coupons(code,kind,value,max_uses) values('FREE','percent',100,1)");
   const sql="select * from public.gpyb_checkout_order(101,7,'purchase','FREE',null,null,'update:11')";
   const a=await row(sql),b=await row(sql);assert.equal(a.id,b.id);assert.equal(a.status,'paid');assert.equal(a.total_toman,0);assert.ok(a.paid_at);assert.equal(a.charge_id,null);
   assert.equal((await row('select count(*)::int n from public.gpyb_orders')).n,1);
   await assert.rejects(()=>query("select * from public.gpyb_checkout_order(102,7,'purchase','FREE',null,null,'update:12')"),/COUPON_EXHAUSTED/);
  });
  await scenario('a free coupon order cannot be reclassified as a wallet payment',async()=>{
   await db.exec("insert into public.gpyb_coupons(code,kind,value) values('FREE','percent',100)");
   const order=await row("select * from public.gpyb_checkout_order(101,7,'purchase','FREE',null,null,'update:3')");
   await assert.rejects(()=>query("select * from public.gpyb_record_payment($1,101,'invented','provider',0,'IRR')",[order.id]),/PAYMENT_MISMATCH/);
  });
  await scenario('token selection cannot replace an order after provisioning has started',async()=>{
   const sub=await row("select * from public.gpyb_bind_token(101,'r1','hash1','cipher',now())");
   const order=await row("select * from public.gpyb_checkout_order(101,7,'purchase',null,null,null,'update:4')");
   await query("update public.gpyb_orders set paid_at=now(),status='provisioning' where id=$1",[order.id]);
   await assert.rejects(()=>query("select * from public.gpyb_select_subscription($1,101,$2,'نام اکستنشن')",[order.id,sub.id]),/RECONCILIATION_REQUIRED/);
  });
  await scenario('renewal does not need profile names and preserves the verified upstream name',async()=>{
   await db.exec("update public.gpyb_customers set first_name='',last_name='' where bale_id=101");
   const sub=await row("select * from public.gpyb_bind_token(101,'remote1','hash1','cipher1',now())");
   const order=await row("select * from public.gpyb_checkout_order(101,7,'renewal',null,$1,'نام اکستنشن','update:1')",[sub.id]);
   assert.equal(order.full_name,'نام اکستنشن');assert.equal(order.total_toman,245000);
  });
  await scenario('rotating a personal token keeps its remote ID and customer ownership',async()=>{
   const a=await row("select * from public.gpyb_bind_token(101,'r1','hash1','cipher1',now())"),b=await row("select * from public.gpyb_bind_token(101,'r1','hash2','cipher2',now())");
   assert.equal(a.id,b.id);assert.equal(b.token_hash,'hash2');
   await assert.rejects(()=>query("select * from public.gpyb_bind_token(102,'r1','hash3','cipher3',now())"),/TOKEN_NOT_OWNED/);
  });
  await scenario('extension replacement preserves existing paid orders and separates identical remote IDs',async()=>{
   await db.exec("update public.gpyb_settings set bot_id=123,extension_account_id='old-account'");
   const old=await row("select * from public.gpyb_bind_token(101,'shared-id','old-hash','old-cipher',now())");
   const order=await row("select * from public.gpyb_checkout_order(101,7,'purchase',null,null,null,'old-request')");
   await query("update public.gpyb_orders set paid_at=now(),status='paid' where id=$1",[order.id]);
   await query("select public.gpyb_save_integration('extension_admin','new-manager',null,'{\"account_id\":\"new-account\"}')");
   const settings=await row('select * from public.gpyb_settings');assert.equal(settings.extension_account_id,'new-account');assert.equal(settings.sales_enabled,false);
   assert.equal((await row('select extension_account_id from public.gpyb_orders where id=$1',[order.id])).extension_account_id,'old-account');
   const current=await row("select * from public.gpyb_bind_token(102,'shared-id','new-hash','new-cipher',now())");
   assert.notEqual(current.id,old.id);assert.equal(current.extension_account_id,'new-account');
   assert.equal((await row('select token_hash from public.gpyb_subscriptions where id=$1',[old.id])).token_hash,'old-hash');
   await db.exec('savepoint wrong_account');
   await assert.rejects(()=>query("select * from public.gpyb_complete($1,'shared-id','wrong-hash','cipher',now())",[order.id]),/EXTENSION_SCOPE/);
   await db.exec('rollback to wrong_account');
   await assert.rejects(()=>query("select * from public.gpyb_bind_token(101,'shared-id','other-hash','cipher',now())"),/TOKEN_NOT_OWNED/);
  });
  await scenario('same bot token rotation retains wallet while a different bot resets wallet and namespaces updates',async()=>{
   await db.exec("update public.gpyb_settings set bot_id=123; insert into public.gpyb_secrets(key,ciphertext) values('bale_payment','wallet-old')");
   await query("select public.gpyb_save_integration('bale_bot','same-bot','webhook-same','{\"bot_id\":123,\"username\":\"same_bot\"}')");
   assert.equal((await row("select ciphertext from public.gpyb_secrets where key='bale_payment'")).ciphertext,'wallet-old');
   assert.equal((await row('select sales_enabled from public.gpyb_settings')).sales_enabled,true);
   const owner='11111111-1111-4111-8111-111111111111';
   assert.equal((await row('select public.gpyb_claim_bot_update(123,42,$1) ok',[owner])).ok,true);
   await db.exec("update public.gpyb_updates set status='done' where bot_id=123 and update_id=42");
   await query("select public.gpyb_save_integration('bale_bot','new-bot','webhook-new','{\"bot_id\":456,\"username\":\"new_bot\"}')");
   assert.equal((await row("select count(*)::int n from public.gpyb_secrets where key='bale_payment'")).n,0);
   const settings=await row('select * from public.gpyb_settings');assert.equal(settings.bot_id,456);assert.equal(settings.sales_enabled,false);
   assert.equal((await row('select public.gpyb_claim_bot_update(456,42,$1) ok',[owner])).ok,true);
   assert.equal((await row('select public.gpyb_claim_bot_update(456,42,$1) ok',[owner])).ok,false);
   await db.exec('update public.gpyb_settings set bot_id=123');
   assert.equal((await row('select public.gpyb_claim_bot_update(123,42,$1) ok',[owner])).ok,false);
   await query("select public.gpyb_save_integration('bale_payment','wallet-new',null,'{}')");
   assert.equal((await row("select ciphertext from public.gpyb_secrets where key='bale_payment'")).ciphertext,'wallet-new');
  });
  await scenario('invoices from another bot or extension account cannot be paid through the new connection',async()=>{
   await db.exec("update public.gpyb_settings set bot_id=123,extension_account_id='old-account'");
   const order=await row("select * from public.gpyb_checkout_order(101,7,'purchase',null,null,null,'invoice-old')");
   await query("select public.gpyb_save_integration('bale_bot','new-bot','webhook','{\"bot_id\":456}')");
   await db.exec('update public.gpyb_settings set sales_enabled=true');
   assert.equal((await row("select public.gpyb_precheckout($1,101,'charge',2450000,'IRR') ok",[order.id])).ok,false);
   await db.exec("update public.gpyb_settings set bot_id=123,extension_account_id='new-account'");
   assert.equal((await row("select public.gpyb_precheckout($1,101,'charge',2450000,'IRR') ok",[order.id])).ok,false);
   assert.equal((await row('select status from public.gpyb_orders where id=$1',[order.id])).status,'pending');
  });
  await scenario('retired connection migration removes secrets and RPCs while retaining historical records',async()=>{
   await db.exec("create table public.gpyb_rubika_users(rubika_id text primary key); insert into public.gpyb_rubika_users values('historical-user'); grant select on public.gpyb_rubika_users to service_role; create function public.gpyb_rubika_identity(text) returns bigint language sql as 'select -1::bigint'; insert into public.gpyb_secrets(key,ciphertext) values('rubika_bot','old-token'),('rubika_webhook','old-webhook'),('bale_payment','wallet')");
   const migration=await readFile(new URL('../supabase/migrations/20261026200939_gpyb_replace_integration_tokens_remove_legacy_messaging.sql',import.meta.url),'utf8');
   await db.exec(migration);await db.exec(migration);
   assert.equal((await row("select count(*)::int n from public.gpyb_secrets where key like 'rubika%'")).n,0);
   assert.equal((await row("select count(*)::int n from pg_proc where proname='gpyb_rubika_identity'")).n,0);
   assert.equal((await row('select count(*)::int n from public.gpyb_rubika_users')).n,1);
   assert.equal((await row("select has_table_privilege('service_role','public.gpyb_rubika_users','select') ok")).ok,false);
   assert.equal((await row('select count(*)::int n from public.gpyb_customers')).n,2);
   assert.equal((await row("select ciphertext from public.gpyb_secrets where key='bale_payment'")).ciphertext,'wallet');
  });
  await scenario('incomplete password changes cannot leave older sessions active',async()=>{
   const a=await row("insert into public.gpyb_admins(username,password_hash,totp_secret,active,last_totp_counter) values('admin','old','encrypted',true,100) returning id");
   await query("insert into public.gpyb_sessions(token_hash,admin_id,stage,expires_at) values('session',$1,'auth',now()+interval '8 hours')",[a.id]);
   assert.equal((await row("select public.gpyb_change_password($1,'old','new',101) ok",[a.id])).ok,true);
   assert.equal((await row("select count(*)::int n from public.gpyb_sessions where expires_at>now()")).n,0);
   assert.equal((await row('select password_hash from public.gpyb_admins where id=$1',[a.id])).password_hash,'new');
  });
  await scenario('enrollment rolls back completely if recovery-code persistence fails',async()=>{
   await db.exec("insert into public.gpyb_bootstrap(id,code_hash,expires_at) values(true,'bootstrap',now()+interval '1 hour')");
   const {id}=await row("select public.gpyb_setup('bootstrap','admin','password','totp','challenge') id");
   const bad=Array(8).fill('a'.repeat(64));await db.exec('savepoint enrollment');
   await assert.rejects(()=>query("select public.gpyb_enroll_auth('challenge',101,'session',$1)",[bad]),/duplicate/);
   await db.exec('rollback to enrollment');
   assert.equal((await row('select active from public.gpyb_admins where id=$1',[id])).active,false);
   assert.equal((await row("select stage from public.gpyb_sessions where token_hash='challenge'")).stage,'setup');
   assert.equal((await row('select used_at from public.gpyb_bootstrap')).used_at,null);
  });
  await scenario('coupon statistics include more than the REST maximum of 1000 rows',async()=>{
   const c=await row("insert into public.gpyb_coupons(code,kind,value,max_uses) values('ALL','percent',50,5000) returning id");
   await query("insert into public.gpyb_orders(bale_id,full_name,kind,days,subtotal_toman,discount_toman,total_toman,coupon_id,status,paid_at) select 101,'آزمایش اول','purchase',1,35000,17500,17500,$1,'paid',now() from generate_series(1,1100)",[c.id]);
   const report=await row('select public.gpyb_coupon_report(1) report');assert.equal(report.report.rows[0].used,1100);
  });
  await scenario('all application tables and new RPCs are inaccessible to browser roles',async()=>{
   const tables=await query("select c.relname,c.relrowsecurity,has_table_privilege('anon',c.oid,'select') anon,has_table_privilege('authenticated',c.oid,'select') authenticated from pg_class c join pg_namespace n on c.relnamespace=n.oid where n.nspname='public' and c.relkind='r' and c.relname like 'gpyb_%'");
   assert.equal(tables.length,16);assert.ok(tables.every(t=>t.relrowsecurity&&!t.anon&&!t.authenticated));
   const funcs=await query("select p.proname,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') authenticated from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname='public' and p.proname like 'gpyb_%'");
   assert.ok(funcs.length>=18);assert.ok(funcs.every(f=>!f.anon&&!f.authenticated));
  });
  // Historical invariants are also run in the isolated database, including TOTP replay and payment duplication.
  await t.test('original SQL payment and TOTP regression suite',async()=>{await db.exec(await readFile(new URL('./database.sql',import.meta.url),'utf8'));});
 }finally{await db.close();}
});
