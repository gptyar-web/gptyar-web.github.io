import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const dir of ['supabase/functions/gptyar-bale','web/src'])for(const file of await readdir(dir)){
 if(!file.endsWith('.js'))continue;
 const result=spawnSync(process.execPath,['--check',`${dir}/${file}`],{stdio:'inherit'});
 if(result.status!==0)process.exit(result.status||1);
}
