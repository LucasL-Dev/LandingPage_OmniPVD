import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=new URL('../',import.meta.url);
const files=['app.js','server.mjs'];
async function discover(dir){for(const entry of await readdir(new URL(dir+'/',root),{withFileTypes:true})){const file=path.posix.join(dir,entry.name);if(entry.isDirectory())await discover(file);else if(/\.(mjs|js)$/.test(file))files.push(file);}}
for(const directory of ['auth','licensing','db','billing','emails','scripts','ops'])await discover(directory);
for(const file of files){const result=spawnSync(process.execPath,['--check',fileURLToPath(new URL(file,root))],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}
console.log(`Sintaxe validada: ${files.length} arquivos.`);
