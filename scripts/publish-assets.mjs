import { cp, rm } from 'node:fs/promises';
await rm('assets',{recursive:true,force:true});
await cp('build/assets','assets',{recursive:true});
await cp('build/index.html','index.html');
