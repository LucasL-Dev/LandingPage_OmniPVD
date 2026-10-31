import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { buildLanding } from '../scripts/build-landing.mjs';
import { packageLanding } from '../scripts/zip-landing.mjs';
import { LANDING_FILES } from '../scripts/landing-files.mjs';
import { createApp } from '../server.mjs';
import { deploymentOrigins } from '../config/origins.mjs';
import { testStripeClient } from '../config/stripe.mjs';

async function tree(dir,prefix='') {
  const result=[];
  for(const entry of await readdir(path.join(dir,prefix),{withFileTypes:true})){
    const name=path.posix.join(prefix,entry.name);
    if(entry.isDirectory())result.push(...await tree(dir,name));else result.push(name);
  }
  return result.sort();
}
const site='https://omnipdv.com.br';
const api='https://api.omnipdv.com.br';

test('build e ZIP têm somente seis arquivos públicos; ZIP sem pasta externa e sem segredos do ambiente',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'omnipdv-static-'));
  const previous=process.env.STRIPE_SECRET_KEY;
  const canary='PRIVATE_BUILD_CANARY_DO_NOT_PUBLISH';process.env.STRIPE_SECRET_KEY=canary;
  try {
    const outputDir=path.join(dir,'dist-landing'),zipPath=path.join(dir,'landing.zip');
    await buildLanding({outputDir});
    await writeFile(path.join(outputDir,'stale-server.mjs'),'PRIVATE STALE FILE');
    await packageLanding({outputDir,zipPath});
    assert.deepEqual(await tree(outputDir),[...LANDING_FILES].sort());
    const entries=unzipSync(await readFile(zipPath));
    assert.deepEqual(Object.keys(entries).sort(),[...LANDING_FILES].sort());
    for(const [name,data]of Object.entries(entries)){
      assert.ok(!name.startsWith('dist-landing/'));
      assert.ok(!/\.env|node_modules|\.sqlite|\.pem|\.exe|server\.mjs/.test(name));
      assert.ok(!Buffer.from(data).includes(Buffer.from(canary)));
      assert.deepEqual(Buffer.from(data),await readFile(path.join(outputDir,name)));
    }
    const html=await readFile(path.join(outputDir,'index.html'),'utf8');
    assert.ok(html.indexOf('landing-config.js')<html.indexOf('src="app.js"'));
    for(const resource of [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(x=>x[1]))assert.ok(LANDING_FILES.includes(resource),resource);
    assert.ok((await readFile(path.join(outputDir,'landing-config.js'),'utf8')).includes(api));
    const js=await readFile(path.join(outputDir,'app.js'),'utf8');
    assert.ok(js.includes("credentials: 'omit'"));assert.ok(js.includes("mode: 'cors'"));
    assert.ok(js.includes('este retorno não confirma a compra'));
  }finally{if(previous===undefined)delete process.env.STRIPE_SECRET_KEY;else process.env.STRIPE_SECRET_KEY=previous;await rm(dir,{recursive:true,force:true});}
});

test('CORS permite somente o site comercial na rota de Checkout e não concede cookies ou Authorization',async()=>{
  process.env.SITE_ORIGIN=site;process.env.API_ORIGIN=api;delete process.env.DOMAIN;
  let calls=0,params;
  const stripe={checkout:{sessions:{create:async value=>{calls++;params=value;return {url:'https://checkout.stripe.com/c/pay/test_fixture'};}}}};
  const server=createApp(stripe);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,route=base+'/api/create-checkout-session';
  try {
    const preflight=await fetch(route,{method:'OPTIONS',headers:{Origin:site,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});
    assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),site);
    assert.equal(preflight.headers.get('access-control-allow-methods'),'POST');assert.equal(preflight.headers.get('access-control-allow-credentials'),null);
    assert.equal(calls,0);
    for(const origin of ['https://www.omnipdv.com.br','https://omnipdv.com.br.evil.invalid','null','https://evil.invalid']){
      const response=await fetch(route,{method:'POST',headers:{Origin:origin}});assert.equal(response.status,403);assert.equal(response.headers.get('access-control-allow-origin'),null);
    }
    const badHeader=await fetch(route,{method:'OPTIONS',headers:{Origin:site,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization'}});assert.equal(badHeader.status,403);
    const badMethod=await fetch(route,{method:'OPTIONS',headers:{Origin:site,'Access-Control-Request-Method':'DELETE'}});assert.equal(badMethod.status,403);
    const cookie=await fetch(route,{method:'POST',headers:{Origin:site,Cookie:'session=not-allowed'}});assert.equal(cookie.status,400);
    assert.equal(calls,0);
    const response=await fetch(route,{method:'POST',headers:{Origin:site,'Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),site);assert.equal(response.headers.get('vary'),'Origin');assert.equal(response.headers.get('access-control-allow-credentials'),null);
    assert.equal(params.success_url,site+'/?checkout=success&session_id={CHECKOUT_SESSION_ID}');
    assert.equal(params.cancel_url,site+'/?checkout=cancelled#assinatura');assert.equal(calls,1);
    for(const pathname of ['/api/stripe/webhook','/api/auth/session','/api/license/status','/api/download']){
      const response=await fetch(base+pathname,{method:'OPTIONS',headers:{Origin:site,'Access-Control-Request-Method':'POST'}});
      assert.equal(response.headers.get('access-control-allow-origin'),null,pathname);
    }
  }finally{await new Promise(resolve=>server.close(resolve));delete process.env.SITE_ORIGIN;delete process.env.API_ORIGIN;}
});

test('site estático e API funcionam em servidores separados; API não publica a landing nem arquivos privados',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'omnipdv-split-'));let frontend,backend;
  process.env.SITE_ORIGIN=site;
  try {
    await buildLanding({outputDir:dir});
    frontend=http.createServer(async(req,res)=>{
      const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
      if(!LANDING_FILES.includes(name)){res.writeHead(404).end();return;}
      res.end(await readFile(path.join(dir,name)));
    });
    backend=createApp({checkout:{sessions:{create:async()=>({url:'https://checkout.stripe.com/c/pay/test_fixture'})}}});
    await Promise.all([new Promise(resolve=>frontend.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve))]);
    const front=`http://127.0.0.1:${frontend.address().port}`,back=`http://127.0.0.1:${backend.address().port}`;
    assert.ok((await (await fetch(front)).text()).includes('Uma nova'));
    assert.equal((await fetch(front+'/api/create-checkout-session',{method:'POST'})).status,404);
    const result=await fetch(back+'/api/create-checkout-session',{method:'POST',headers:{Origin:site}});assert.equal(result.status,200);
    const redirect=await fetch(back+'/',{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),site);
    for(const pathname of ['/app.js','/styles.css','/assets/omnipdv-app.png','/.env','/server.mjs','/auth/service.mjs','/dist-landing/index.html','/node_modules/stripe/package.json','/private/setup.exe'])assert.equal((await fetch(back+pathname)).status,404,pathname);
    assert.equal((await fetch(back+'/health')).status,200);assert.equal((await fetch(back+'/assets/omnipdv.png')).status,200);
  }finally{for(const server of [frontend,backend])if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});delete process.env.SITE_ORIGIN;}
});

test('origens comerciais, API e alias legado são independentes e configurações inseguras são rejeitadas',()=>{
  assert.deepEqual(deploymentOrigins({SITE_ORIGIN:site,API_ORIGIN:api,DOMAIN:'https://old.example.invalid'}),{site,api});
  assert.equal(deploymentOrigins({DOMAIN:'http://localhost:4173'}).site,'http://localhost:4173');
  for(const value of ['*','https://omnipdv.com.br/path','https://omnipdv.com.br/','http://omnipdv.com.br','https://user:pass@omnipdv.com.br'])assert.throws(()=>deploymentOrigins({SITE_ORIGIN:value}));
});

test('runtime não aceita chave Stripe live ou outra credencial',()=>{
  assert.equal(testStripeClient(''),null);
  assert.throws(()=>testStripeClient('sk_live_NOT_A_REAL_SECRET'),/Somente chave Stripe de teste/);
  assert.throws(()=>testStripeClient('rk_live_NOT_A_REAL_SECRET'),/Somente chave Stripe de teste/);
  assert.ok(testStripeClient('sk_test_NOT_A_REAL_SECRET'));
});
