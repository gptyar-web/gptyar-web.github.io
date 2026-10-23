import {randomBytes,createHash} from 'node:crypto';
const code=randomBytes(32).toString('hex'),hash=createHash('sha256').update(code).digest('hex');
console.log('Run this SQL on the application database before an administrator is activated:\n');
console.log(`insert into public.gpyb_bootstrap(id,code_hash,expires_at) select true,'${hash}',now()+interval '7 days' where not exists(select 1 from public.gpyb_admins where active) on conflict(id) do update set code_hash=excluded.code_hash,expires_at=excluded.expires_at,used_at=null;`);
console.log('\nPrivate one-time setup link (do not commit):\nhttps://gptyar-web.github.io/#setup='+code);
