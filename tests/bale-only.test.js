import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
test('active server and published panel do not reference the removed provider',async()=>{
 const entries=['supabase/functions/gptyar-bale/index.js','supabase/functions/gptyar-bale/bot.js',
  'supabase/functions/gptyar-bale/admin.js','supabase/functions/gptyar-bale/integrations.js',
  'supabase/functions/gptyar-bale/clients.js','web/src/app.js','index.html'];
 for(const name of await readdir(new URL('assets/',root)))if(name.endsWith('.js'))entries.push('assets/'+name);
 for(const name of entries){const content=await readFile(new URL(name,root),'utf8');
  assert.doesNotMatch(content,/rubika|روبیکا/i,'Unexpected provider reference in '+name);
 }
});
