import {readFile,access} from 'node:fs/promises';
import assert from 'node:assert/strict';
const html=await readFile('index.html','utf8');
const assets=[...html.matchAll(/(?:src|href)="(\.\/assets\/[^"?#]+)(?:[^" ]*)"/g)].map(m=>m[1]);
assert.ok(assets.some(p=>p.endsWith('.js'))&&assets.some(p=>p.endsWith('.css')));
for(const path of assets){await access(path);if(path.endsWith('.css')){const css=await readFile(path,'utf8');assert.match(css,/Vazirmatn/);for(const m of css.matchAll(/url\((?:["']?)([^)'"?#]+)(?:[^)]*)\)/g))if(!m[1].startsWith('data:'))await access('assets/'+m[1].replace(/^\.\//,''));}}
assert.ok(!html.includes('coupon-calendar.js'),'The picker must be bundled from its single source');
assert.equal(await readFile('build/index.html','utf8'),html);
process.stdout.write('Build references and local Vazirmatn assets verified.\n');
