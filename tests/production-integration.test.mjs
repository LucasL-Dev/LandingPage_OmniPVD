import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateDeployment } from '../ops/config.mjs';
import { createApp } from '../server.mjs';
import { queueWorker } from '../ops/worker.mjs';

const site='https://omnipdv.com.br',api='https://api.omnipdv.com.br';
const config={DEPLOY_ENV:'production',HOST:'127.0.0.1',SITE_ORIGIN:site,API_ORIGIN:api,AUTH_ORIGIN:api,DOWNLOAD_ORIGIN:api,AUTH_RP_ID:'api.omnipdv.com.br',AUTH_ALLOW_LOCALHOST:'false',AUTH_ENABLED:'true',BILLING_DB_PATH:'/var/lib/omnipdv/billing.sqlite',LICENSE_PRIVATE_KEY_PATH:'/srv/omnipdv-private/existing.pem',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_PRICE_ID:'price_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture'};

test('VPS aceita site e API separados, preserva alias comercial e recusa mistura de origens e live',()=>{
 assert.equal(validateDeployment(config).stage,'production');
 assert.doesNotThrow(()=>validateDeployment({...config,DOMAIN:'https://old.invalid'}));
 assert.doesNotThrow(()=>validateDeployment({...config,STRIPE_SECRET_KEY:'rk_test_fixture'}));
 for(const changes of [{API_ORIGIN:site},{AUTH_ORIGIN:site},{DOWNLOAD_ORIGIN:site},{AUTH_RP_ID:'omnipdv.com.br'},{STRIPE_SECRET_KEY:'sk_live_fixture'},{STRIPE_SECRET_KEY:'rk_live_fixture'}])assert.throws(()=>validateDeployment({...config,...changes}));
 const legacy={...config,DOMAIN:site};delete legacy.SITE_ORIGIN;assert.doesNotThrow(()=>validateDeployment(legacy));
 assert.throws(()=>validateDeployment({...legacy,DOMAIN:api}));
});

test('CORS/preflight preserva limite de Checkout, URLs comerciais e health/readiness da VPS',async()=>{
 const previous=process.env.SITE_ORIGIN;process.env.SITE_ORIGIN=site;
 let calls=0,ready=true;
 const server=createApp({checkout:{sessions:{create:async input=>{calls++;assert.equal(input.success_url,site+'/?checkout=success&session_id={CHECKOUT_SESSION_ID}');assert.equal(input.cancel_url,site+'/?checkout=cancelled#assinatura');return{url:'https://checkout.stripe.com/test'};}}}},null,null,{ready:()=>ready});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  for(let i=0;i<65;i++)assert.equal((await fetch(base+'/api/create-checkout-session',{method:'OPTIONS',headers:{Origin:site,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type'}})).status,204);
  for(let i=0;i<60;i++)assert.equal((await fetch(base+'/api/create-checkout-session',{method:'POST',headers:{Origin:site}})).status,200);
  const limited=await fetch(base+'/api/create-checkout-session',{method:'POST',headers:{Origin:site}});assert.equal(limited.status,429);assert.equal(limited.headers.get('access-control-allow-origin'),site);assert.equal(calls,60);
  ready=false;assert.equal((await fetch(base+'/readyz')).status,503);assert.equal((await fetch(base+'/healthz')).status,200);assert.equal((await fetch(base+'/health')).status,200);
  assert.equal((await fetch(base+'/',{redirect:'manual'})).headers.get('location'),site);
  for(const route of ['/api/stripe/webhook','/api/license/status','/api/auth/session','/api/download']){
   const result=await fetch(base+route,{method:'OPTIONS',headers:{Origin:site,'Access-Control-Request-Method':'POST'}});assert.equal(result.headers.get('access-control-allow-origin'),null);
  }
 }finally{if(previous===undefined)delete process.env.SITE_ORIGIN;else process.env.SITE_ORIGIN=previous;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('worker integrado afeta readiness, mantém erro genérico e encerra antes de fechar o banco',async()=>{
 let stopped=false;const logs=[];
 const worker=queueWorker({runQueue:async()=>{throw Error('provider-private-details');},stopQueue:()=>{stopped=true;}},{interval:5000,log:code=>logs.push(code)});
 const server=createApp(null,null,null,{ready:()=>worker.status().ok});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  for(let i=0;i<100 && worker.status().ok;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(worker.status().ok,false);assert.deepEqual(logs,['queue_unavailable']);
  const response=await fetch(base+'/readyz');assert.equal(response.status,503);assert.deepEqual(await response.json(),{status:'unavailable'});
  await worker.stop();assert.equal(stopped,true);
 }finally{await worker.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('exemplos e ativos operacionais usam Caddy/API e preservam timer, lock e segredo fora do código',async()=>{
 const env=await readFile(new URL('../ops/backend.env.example',import.meta.url),'utf8');
 const values=Object.fromEntries(env.split('\n').filter(line=>/^[A-Z_]+=/.test(line)).map(line=>{const cut=line.indexOf('=');return[line.slice(0,cut),line.slice(cut+1)];}));
 assert.doesNotThrow(()=>validateDeployment(values));assert.equal(values.SITE_ORIGIN,site);assert.equal(values.AUTH_ORIGIN,api);assert.equal(values.DOWNLOAD_ORIGIN,api);
 const caddy=await readFile(new URL('../ops/Caddyfile',import.meta.url),'utf8');
 assert.match(caddy,/^\{\$OMNIPDV_DOMAIN:api\.omnipdv\.com\.br\}\s*\{/m);assert.ok(!/^omnipdv\.com\.br\s*\{/m.test(caddy));assert.ok(!/Access-Control-Allow-Origin/i.test(caddy));assert.match(caddy,/exclude http.log.access http.log.error/);
 const backup=await readFile(new URL('../ops/systemd/omnipdv-backup.service',import.meta.url),'utf8');assert.match(backup,/scripts\/backup.mjs/);assert.match(backup,/UMask=0077/);
 const timer=await readFile(new URL('../ops/systemd/omnipdv-backup.timer',import.meta.url),'utf8');assert.match(timer,/Persistent=true/);
 const unit=await readFile(new URL('../ops/systemd/omnipdv.service',import.meta.url),'utf8');assert.match(unit,/flock --nonblock --no-fork/);assert.match(unit,/EnvironmentFile=\/etc\/omnipdv\/backend.env/);
});
