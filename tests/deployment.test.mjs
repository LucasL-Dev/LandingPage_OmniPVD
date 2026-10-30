import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { SignJWT, jwtVerify, createLocalJWKSet } from 'jose';
import { createApp } from '../server.mjs';
import { validateDeployment } from '../ops/config.mjs';
import { queueWorker } from '../ops/worker.mjs';
import { backupDatabase } from '../scripts/backup.mjs';
import { createLicensing } from '../licensing/service.mjs';
const production={DEPLOY_ENV:'production',HOST:'127.0.0.1',DOMAIN:'https://account.example.invalid',AUTH_ORIGIN:'https://account.example.invalid',DOWNLOAD_ORIGIN:'https://account.example.invalid',AUTH_RP_ID:'account.example.invalid',AUTH_ALLOW_LOCALHOST:'false',AUTH_ENABLED:'true',BILLING_DB_PATH:'/var/lib/omnipdv/billing.sqlite',LICENSE_PRIVATE_KEY_PATH:'/srv/omnipdv-private/key.pem',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_PRICE_ID:'price_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture'};
test('production config requires exact HTTPS/RP, loopback, private paths, flags and test-only Stripe',()=>{
 assert.equal(validateDeployment(production).host,'127.0.0.1');
 for(const override of [{STRIPE_SECRET_KEY:'sk_live_NOT_REAL'},{HOST:'0.0.0.0'},{DOMAIN:'http://localhost:3000'},{AUTH_ORIGIN:'https://different.invalid'},{AUTH_RP_ID:'wrong.invalid'},{AUTH_ALLOW_LOCALHOST:'true'},{BILLING_DB_PATH:'relative.sqlite'},{MAX_CONCURRENT_DOWNLOADS:'999'},{AUTO_WELCOME_EMAIL_ENABLED:'yes'},{AUTH_ENABLED:'false'}])assert.throws(()=>validateDeployment({...production,...override}));
 assert.throws(()=>validateDeployment({STRIPE_SECRET_KEY:'sk_live_NOT_REAL'}));
 assert.throws(()=>validateDeployment({...production,AUTO_WELCOME_EMAIL_ENABLED:'true'}));
});
test('health reveals only generic status and private routes remain inaccessible',async()=>{
 let ready=true;const server=createApp(null,null,null,{ready:()=>ready});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 try{
  for(const route of ['/healthz','/readyz']){const r=await fetch(origin+route);assert.equal(r.status,200);assert.deepEqual(await r.json(),{status:'ok'});assert.equal(r.headers.get('cache-control'),'no-store');}
  ready=false;assert.equal((await fetch(origin+'/readyz')).status,503);assert.equal((await fetch(origin+'/healthz')).status,200);
  assert.equal((await fetch(origin+'/healthz',{method:'POST'})).status,405);
  for(const route of ['/.env','/ops/backend.env.example','/billing/service.mjs','/private/setup.exe','/../server.mjs','/billing.sqlite','/license.pem','/node_modules/stripe/package.json','/%2eenv','/ops/Caddyfile'])assert.equal((await fetch(origin+route)).status,404,route);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('backup uses SQLite online API, includes uncheckpointed WAL, preserves original and refuses missing source',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'omni-vps-backup-'));let db;
 try{const source=join(dir,'existing.sqlite');db=new DatabaseSync(source);db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE preserve(value TEXT); INSERT INTO preserve VALUES(\'unchanged\')');
 const destination=await backupDatabase(source,join(dir,'backups'));const copy=new DatabaseSync(destination,{readOnly:true});try{assert.equal(copy.prepare('SELECT value FROM preserve').get().value,'unchanged');}finally{copy.close();}
 assert.equal(db.prepare('SELECT count(*) n FROM preserve').get().n,1);if(process.platform!=='win32')assert.equal((await stat(destination)).mode&0o777,0o600);
 await assert.rejects(backupDatabase(join(dir,'missing.sqlite'),join(dir,'backups')));await assert.rejects(stat(join(dir,'missing.sqlite')));
 const second=await backupDatabase(source,join(dir,'backups'));assert.notEqual(destination,second);
 }finally{db?.close();await rm(dir,{recursive:true,force:true});}
});
test('worker serializes ticks, reports safe diagnostics, recovers and drains before closing',async()=>{
 let calls=0,finish,fail=true;const logs=[];const billing={runQueue:async()=>{calls++;await new Promise(r=>finish=r);if(fail)throw Error('secret-provider-response');}};
 const worker=queueWorker(billing,{interval:10,log:code=>logs.push(code)});
 await new Promise(r=>setTimeout(r,30));assert.equal(calls,1);finish();await new Promise(r=>setTimeout(r,5));assert.equal(worker.status().ok,false);assert.deepEqual(logs,['queue_unavailable']);
 fail=false;await new Promise(r=>setTimeout(r,20));finish();await new Promise(r=>setTimeout(r,1));assert.equal(worker.status().ok,true);
 await new Promise(r=>setTimeout(r,20));const stopping=worker.stop();finish();await stopping;const before=calls;await new Promise(r=>setTimeout(r,30));assert.equal(calls,before);
});
test('rotation publishes old and new public keys without exposing private material',async()=>{
 const old=generateKeyPairSync('ed25519'),next=generateKeyPairSync('ed25519');const previous={...old.publicKey.export({format:'jwk'}),kid:'old',alg:'EdDSA',use:'sig'};
 const options={db:{},stripe:{},privateKeyPem:next.privateKey.export({format:'pem',type:'pkcs8'}),config:{keyId:'new',previousPublicKeys:[previous]}};
 const licensing=await createLicensing(options);assert.equal(licensing.jwks.keys.length,2);assert.ok(licensing.jwks.keys.every(k=>!k.d));
 const token=await new SignJWT({product:'omnipvd'}).setProtectedHeader({alg:'EdDSA',kid:'old'}).setExpirationTime('1h').sign(old.privateKey);
 assert.equal((await jwtVerify(token,createLocalJWKSet(licensing.jwks),{algorithms:['EdDSA']})).payload.product,'omnipvd');
 await assert.rejects(createLicensing({...options,config:{keyId:'new',previousPublicKeys:[{...previous,d:'private'}]}}));
 await assert.rejects(createLicensing({...options,config:{keyId:'new',previousPublicKeys:[previous,previous]}}));
});
test('deployment assets enforce non-root, single flock, private files, no proxy file server or sensitive URL logs',async()=>{
 const unit=await readFile(new URL('../ops/systemd/omnipdv.service',import.meta.url),'utf8');assert.match(unit,/User=omnipdv/);assert.match(unit,/flock --nonblock --no-fork/);assert.match(unit,/ProtectSystem=strict/);
 const caddy=await readFile(new URL('../ops/Caddyfile',import.meta.url),'utf8');assert.match(caddy,/exclude http.log.access http.log.error/);assert.ok(!/^\s*(file_server|root)\b/m.test(caddy));assert.match(caddy,/max_size 1MB/);
});
test('runtime starts on loopback, exposes health and exits cleanly on SIGTERM without secrets', {skip:process.platform==='win32'},async()=>{
 const {createServer}=await import('node:net'),{spawn}=await import('node:child_process');
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const env={...process.env,DEPLOY_ENV:'development',HOST:'127.0.0.1',PORT:String(port),STRIPE_SECRET_KEY:'',BILLING_DB_PATH:'',AUTH_ENABLED:'false',AUTO_WELCOME_EMAIL_ENABLED:'false',PRIVATE_DOWNLOAD_ENABLED:'false'};
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('../',import.meta.url),env,stdio:['ignore','pipe','pipe']});let logs='';child.stderr.on('data',b=>logs+=b);child.stdout.on('data',b=>logs+=b);
 const exited=new Promise((r,j)=>{child.once('error',j);child.once('exit',(code,signal)=>r({code,signal}));});
 try{
  let ready=false;for(let i=0;i<100;i++){try{const response=await fetch(`http://127.0.0.1:${port}/readyz`);if(response.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,20));}assert.equal(ready,true);
  child.kill('SIGTERM');const result=await Promise.race([exited,new Promise((_,j)=>setTimeout(()=>j(Error('Shutdown timeout')),3000).unref())]);assert.equal(result.code,0);assert.ok(!logs.includes('STRIPE_SECRET_KEY'));
 }finally{if(child.exitCode===null)child.kill('SIGKILL');await exited;}
});
test('Checkout has a bounded global rate without changing accepted session parameters',async()=>{
 let calls=0;const stripe={checkout:{sessions:{create:async()=>{calls++;return {url:'https://checkout.stripe.com/test'};}}}};
 const server=createApp(stripe);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 try{for(let i=0;i<60;i++)assert.equal((await fetch(origin+'/api/create-checkout-session',{method:'POST'})).status,200);
 const limited=await fetch(origin+'/api/create-checkout-session',{method:'POST'});assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');assert.equal(calls,60);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
