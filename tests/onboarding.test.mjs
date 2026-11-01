import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes,generateKeyPairSync } from 'node:crypto';
import { createBilling } from '../billing/service.mjs';
import { createAuth } from '../auth/service.mjs';
import { createOnboarding } from '../onboarding/service.mjs';
import { migrateLicensing } from '../db/migrate.mjs';
import { createLicensing } from '../licensing/service.mjs';
import { hash } from '../auth/common.mjs';
import { authenticator } from './helpers/webauthn.mjs';
import { createApp } from '../server.mjs';
import { createAuthHandler } from '../auth/http.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const iter=values=>({async *[Symbol.asyncIterator](){yield* values;}});
async function fixture() {
 const dir=await mkdtemp(path.join(tmpdir(),'omnipdv-onboarding-'));await writeFile(path.join(dir,'installer.exe'),'PRIVATE TEST FIXTURE');
 let clock=Date.now(),fail=false;const calls=[],invoices=new Map(),subs=new Map(),key=randomBytes(32),signer=generateKeyPairSync('ed25519');
 const config={origin:'https://api.omnipdv.com.br',rpId:'api.omnipdv.com.br',secureCookies:true,accessTtlMs:600000,sessionTtlMs:2592000000,browserTtlMs:43200000,priceId:'price_fixture',from:'sender@example.invalid',supportEmail:'support@example.invalid'};
 const stripe={subscriptions:{retrieve:async sid=>structuredClone(subs.get(sid)),list:params=>iter([...subs.values()].filter(s=>s.customer.id===params.customer))},invoices:{retrieve:async iid=>structuredClone(invoices.get(iid)),list:params=>iter([...invoices.values()].filter(i=>i.customer===params.customer&&i.subscription===params.subscription))}};
 const resend={emails:{send:async(payload,options)=>{calls.push({payload,options:{idempotencyKey:options.idempotencyKey}});if(fail)return{error:{name:'application_error',message:'PRIVATE_ERROR'}};return{data:{id:'mail-'+calls.length}};}}};
 const billingConfig={projectRoot:root,dbPath:path.join(dir,'billing.sqlite'),emailEnabled:true,downloadEnabled:true,installerPath:path.join(dir,'installer.exe'),downloadOrigin:config.origin,priceId:config.priceId,from:config.from,supportEmail:config.supportEmail};
 let billing,auth,onboarding,licensing,server;
 async function open() {
  billing=createBilling({stripe,resend,config:billingConfig,now:()=>clock});migrateLicensing(billing.db);
  onboarding=createOnboarding({db:billing.db,stripe,delivery:billing.onboardingDelivery,config,key,now:()=>clock});billing.attachOnboarding(onboarding);
  auth=createAuth({db:billing.db,config,onboarding,now:()=>clock});
  licensing=await createLicensing({db:billing.db,stripe,privateKeyPem:signer.privateKey.export({format:'pem',type:'pkcs8'}),config:{priceId:config.priceId,keyId:'test-key',issuer:config.origin,audience:'omnipvd-desktop',offlineTtlSeconds:14400,recheckSeconds:900},now:()=>clock});
 }
 await open();
 const addBuyer=(customer,email)=>{
  const invoice={id:'in_'+customer,customer,subscription:'sub_'+customer,livemode:false,status:'paid',paid:true,customer_email:email,billing_reason:'subscription_create',amount_paid:7990,currency:'brl',created:Math.floor(clock/1000),lines:{has_more:false,data:[{price:{id:config.priceId},subscription:'sub_'+customer,period:{start:Math.floor(clock/1000)-60,end:Math.floor(clock/1000)+86400*30}}]}};
  invoices.set(invoice.id,invoice);subs.set(invoice.subscription,{id:invoice.subscription,customer:{id:customer,name:'Buyer',email:'other-contact@example.invalid'},livemode:false,status:'active',latest_invoice:invoice,items:{data:[{price:{id:config.priceId,product:{name:'OmniPDV'},recurring:{interval:'month',interval_count:1}}}]}});return invoice;
 };
 const initial=addBuyer('cus_A','buyer@example.invalid');
 return {dir,calls,invoices,subs,initial,config,stripe,key,get billing(){return billing},get auth(){return auth},get onboarding(){return onboarding},get licensing(){return licensing},addBuyer,setFail:value=>fail=value,advance:ms=>clock+=ms,now:()=>clock,
  async pay(customer='cus_A',eventId='evt_'+customer,type='invoice.paid'){await billing.receive({id:eventId,type,livemode:false,data:{object:{id:'in_'+customer}}});},
  async welcome(customer='cus_A'){await this.pay(customer);await billing.runQueue();const mail=calls.find(c=>c.payload.to===invoices.get('in_'+customer).customer_email&&c.payload.subject.startsWith('Bem-vindo')&&c.options.idempotencyKey==='omnipvd-welcome-sub_'+customer);assert.ok(mail);return {mail,token:new URL(mail.payload.text.match(/https:\/\/[^\s]+\/account\/login#[^\s]+/)[0]).hash.slice('#invite='.length)};},
  code(){const mail=[...calls].reverse().find(c=>c.payload.subject==='OmniPDV — código de verificação');assert.ok(mail);return mail.payload.text.match(/\b\d{8}\b/)[0];},
  async ownership(token){const started=await onboarding.start({claimToken:token});await billing.runQueue();const result=await onboarding.verify({claimToken:token,verificationId:started.verificationId,code:this.code()});return result.emailProof;},
  async register(token,emailProof){const flow=await auth.registrationOptions({claimToken:token,emailProof,displayName:'Verified buyer'});const device=authenticator();return auth.registrationVerify({claimToken:token,emailProof,flowToken:flow.flowToken,response:device.register(flow.options,config.origin)});},
  desktop(browserToken){const verifier=randomBytes(48).toString('base64url'),params={client_id:'omnipvd-desktop',response_type:'code',redirect_uri:'http://127.0.0.1:54321/omnipvd/callback',code_challenge_method:'S256',code_challenge:hash(verifier),state:randomBytes(32).toString('base64url'),installation_id:randomBytes(24).toString('base64url')};const result=auth.authorize(auth.browserSession(browserToken),params);return auth.exchange({client_id:'omnipvd-desktop',grant_type:'authorization_code',code:new URL(result.redirect_uri).searchParams.get('code'),code_verifier:verifier,redirect_uri:params.redirect_uri});},
  async reopen(){billing.close();await open();},
  async listen(){server=createApp(stripe,billing,{handle:createAuthHandler({auth,licensing,onboarding,db:billing.db,config,now:()=>clock})});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;},
  async close(){if(server)await new Promise(resolve=>server.close(resolve));billing.close();await rm(dir,{recursive:true,force:true});}
 };
}

test('pagamento aprovado gera boas-vindas com convite; e-mail comprovado + passkey ativam a licença correta',async()=>{
 const f=await fixture();try{
  const {mail,token}=await f.welcome();assert.equal(mail.payload.to,'buyer@example.invalid');assert.ok(mail.payload.html.includes('Ativar minha conta'));assert.ok(mail.payload.text.includes('/api/download?token='));
  await assert.rejects(f.auth.registrationOptions({claimToken:token,displayName:'Attack'}),/email_verification_required/);
  const proof=await f.ownership(token);const enrolled=await f.register(token,proof);const tokens=f.desktop(enrolled.browserToken);
  assert.equal((await f.licensing.status(f.auth.accessSession(tokens.access_token))).authorized,true);
  assert.equal(f.billing.db.prepare('SELECT customer_id FROM auth_stripe_links').get().customer_id,'cus_A');
  await assert.rejects(f.register(token,proof),/invalid_invite/);
 }finally{await f.close()}
});

test('pagamento recusado e webhook duplicado não criam convites ou contas indevidos',async()=>{
 const f=await fixture();try{
  f.initial.status='open';f.initial.paid=false;await f.pay();await f.billing.runQueue();assert.equal(f.calls.length,0);assert.equal(f.billing.db.prepare('SELECT count(*) n FROM onboarding_invites').get().n,0);
  f.initial.status='paid';f.initial.paid=true;await f.pay('cus_A','evt_recovered');await f.pay('cus_A','evt_recovered');await f.billing.runQueue();await f.pay('cus_A','evt_second');await f.billing.runQueue();
  assert.equal(f.calls.length,1);assert.equal(f.billing.db.prepare('SELECT count(*) n FROM onboarding_invites').get().n,1);assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,0);
 }finally{await f.close()}
});

test('tentativa entre compradores falha; convites/códigos/provas são vinculados e de uso único',async()=>{
 const f=await fixture();try{
  const a=await f.welcome();f.addBuyer('cus_B','second@example.invalid');const b=await f.welcome('cus_B');
  const start=await f.onboarding.start({claimToken:a.token});await f.billing.runQueue();const code=f.code();
  await assert.rejects(f.onboarding.verify({claimToken:b.token,verificationId:start.verificationId,code}),/invalid_verification/);
  const {emailProof}=await f.onboarding.verify({claimToken:a.token,verificationId:start.verificationId,code});
  await assert.rejects(f.onboarding.verify({claimToken:a.token,verificationId:start.verificationId,code}),/invalid_verification/);
  await assert.rejects(f.register(b.token,emailProof),/email_verification_required/);await f.register(a.token,emailProof);
  const row=f.billing.db.prepare('SELECT customer_id FROM auth_stripe_links').get();assert.equal(row.customer_id,'cus_A');
 }finally{await f.close()}
});

test('convite expirado pode ser recuperado apenas após código ao endereço congelado da compra',async()=>{
 const f=await fixture();try{
  const original=await f.welcome();f.advance(49*3600_000);
  await assert.rejects(f.onboarding.start({claimToken:original.token}),/invalid_invite/);
  const unknown=await f.onboarding.recoveryStart({email:'unknown@example.invalid'});const before=f.calls.length;await f.billing.runQueue();assert.equal(f.calls.length,before);assert.deepEqual(Object.keys(unknown).sort(),['ok','verificationId']);
  const recovery=await f.onboarding.recoveryStart({email:'buyer@example.invalid'});await f.billing.runQueue();
  await assert.rejects(f.onboarding.recoveryVerify({verificationId:recovery.verificationId,code:f.code()==='00000000'?'11111111':'00000000'}),/invalid_verification/);
  const renewed=await f.onboarding.recoveryVerify({verificationId:recovery.verificationId,code:f.code()});assert.notEqual(renewed.claimToken,original.token);
  await assert.rejects(f.onboarding.start({claimToken:original.token}),/invalid_invite/);
  await f.register(renewed.claimToken,renewed.emailProof);
  await assert.rejects(f.onboarding.recoveryVerify({verificationId:recovery.verificationId,code:f.code()}),/invalid_verification/);
 }finally{await f.close()}
});

test('Resend incerto e reinício preservam mensagem e chave idempotente; tokens não ficam em texto no SQLite',async()=>{
 const f=await fixture();try{
  f.setFail(true);await f.pay();await f.billing.runQueue();const first=f.calls[0],token=new URL(first.payload.text.match(/https:\/\/[^\s]+\/account\/login#[^\s]+/)[0]).hash.slice('#invite='.length);
  const payload=f.billing.db.prepare('SELECT payload FROM deliveries').get().payload;assert.ok(payload.startsWith('onboarding1.'));assert.ok(!payload.includes(token));assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_claims').get().n,0);
  await f.reopen();f.advance(61000);f.setFail(false);await f.billing.runQueue();assert.deepEqual(f.calls[0],f.calls[1]);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM onboarding_invites').get().n,1);
  const start=await f.onboarding.start({claimToken:token});f.setFail(true);await f.billing.runQueue();const failed=f.calls.at(-1);f.advance(61000);f.setFail(false);await f.billing.runQueue();assert.deepEqual(failed,f.calls.at(-1));
  assert.equal((await f.onboarding.verify({claimToken:token,verificationId:start.verificationId,code:f.code()})).ok,true);
 }finally{await f.close()}
});

test('mesmo e-mail comprovado exige conta existente; não associa outro cliente por igualdade de e-mail',async()=>{
 const f=await fixture();try{
  const a=await f.welcome(),pa=await f.ownership(a.token),owner=await f.register(a.token,pa);
  f.addBuyer('cus_B','buyer@example.invalid');const b=await f.welcome('cus_B');const pb=await f.ownership(b.token);
  await assert.rejects(f.register(b.token,pb),/existing_account_login_required/);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,1);
  f.auth.linkClaim(owner.session.account_id,b.token,pb);assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_stripe_links').get().n,2);
 }finally{await f.close()}
});

test('contas e convites administrativos existentes continuam funcionando; desativar automação não remove prova de e-mail',async()=>{
 const f=await fixture();try{
  const {token}=await f.welcome();
  const legacy=createAuth({db:f.billing.db,config:f.config,now:()=>f.now()});await assert.rejects(legacy.registrationOptions({claimToken:token,displayName:'Bypass'}),/invalid_claim/);
  const administrative=f.auth.issueClaim('cus_A','support-verified');const owner=await f.register(administrative);
  assert.ok(owner.browserToken);await assert.rejects(f.onboarding.start({claimToken:token}),/invalid_invite/);
  const recovery=await f.onboarding.recoveryStart({email:'buyer@example.invalid'});const count=f.calls.length;await f.billing.runQueue();assert.equal(f.calls.length,count);assert.ok(recovery.verificationId);
 }finally{await f.close()}
});

test('OTP expira, limita tentativas e não pode ser substituído por session_id ou download token',async()=>{
 const f=await fixture();try{
  const {token,mail}=await f.welcome(),started=await f.onboarding.start({claimToken:token});await f.billing.runQueue();const correct=f.code();
  const wrong=correct==='00000000'?'11111111':'00000000';
  for(let i=0;i<5;i++)await assert.rejects(f.onboarding.verify({claimToken:token,verificationId:started.verificationId,code:wrong}),/invalid_verification/);
  await assert.rejects(f.onboarding.verify({claimToken:token,verificationId:started.verificationId,code:correct}),/invalid_verification/);
  const next=await f.onboarding.start({claimToken:token});await f.billing.runQueue();const code=f.code();f.advance(601000);await assert.rejects(f.onboarding.verify({claimToken:token,verificationId:next.verificationId,code}),/invalid_verification/);
  const download=new URL(mail.payload.text.match(/https:\/\/[^\s]+\/api\/download\?[^\s]+/)[0]).searchParams.get('token');await assert.rejects(f.onboarding.start({claimToken:download}),/invalid_invite/);
  await assert.rejects(f.onboarding.start({claimToken:'cs_test_fake'}),/invalid_invite/);
 }finally{await f.close()}
});

test('endpoints de onboarding exigem origem da API, não recebem CORS comercial e aplicam rate limit',async()=>{
 const f=await fixture();try{
  const base=await f.listen();
  const post=(origin,email)=>fetch(base+'/api/auth/onboarding/recover/start',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});
  assert.equal((await post('https://omnipdv.com.br','unknown@example.invalid')).status,403);
  const response=await post(f.config.origin,'unknown@example.invalid');assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),null);assert.equal(response.headers.get('cache-control'),'no-store');
  for(let i=0;i<2;i++)assert.equal((await post(f.config.origin,'unknown@example.invalid')).status,200);
  const limited=await post(f.config.origin,'unknown@example.invalid');assert.equal(limited.status,429);assert.equal(limited.headers.get('Retry-After'),'60');
 }finally{await f.close()}
});

test('prova de e-mail expira e falha Stripe não gera novo convite nem conta',async()=>{
 const f=await fixture();try{
  const retrieve=f.stripe.subscriptions.retrieve;f.stripe.subscriptions.retrieve=async()=>{throw Error('temporary-provider-error');};
  await assert.rejects(f.pay());assert.equal(f.billing.db.prepare('SELECT count(*) n FROM onboarding_invites').get().n,0);
  f.stripe.subscriptions.retrieve=retrieve;const {token}=await f.welcome();const proof=await f.ownership(token);f.advance(601000);
  await assert.rejects(f.register(token,proof),/email_verification_required/);assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,0);
 }finally{await f.close()}
});

test('endereço da fatura ausente ou alterado não envia convite a outro contato',async()=>{
 const f=await fixture();try{
  const address=f.initial.customer_email;delete f.initial.customer_email;await f.pay();await f.billing.runQueue();assert.equal(f.calls.length,0);assert.equal(f.billing.db.prepare('SELECT count(*) n FROM onboarding_invites').get().n,0);
  f.initial.customer_email=address;f.advance(31000);await f.billing.runQueue();assert.equal(f.calls[0].payload.to,address);
  const token=new URL(f.calls[0].payload.text.match(/https:\/\/[^\s]+\/account\/login#[^\s]+/)[0]).hash.slice('#invite='.length);
  f.initial.customer_email='attacker@example.invalid';await assert.rejects(f.onboarding.start({claimToken:token}),/invalid_invite/);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,0);
 }finally{await f.close()}
});

test('comprador já vinculado recebe login existente, sem novo convite ou alteração da conta',async()=>{
 const f=await fixture();try{
  const admin=f.auth.issueClaim('cus_A','verified-existing-account');const owner=await f.register(admin);
  await f.pay();await f.billing.runQueue();assert.equal(f.calls.length,1);assert.ok(!f.calls[0].payload.text.includes('#invite='));assert.ok(f.calls[0].payload.html.includes('Acessar minha conta'));
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM onboarding_invites').get().n,0);assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,1);
  assert.equal(f.billing.db.prepare('SELECT account_id FROM auth_stripe_links').get().account_id,owner.session.account_id);
 }finally{await f.close()}
});

test('troca acidental da chave de outbox é bloqueada sem alterar os dados existentes',async()=>{
 const f=await fixture();try{
  const {token}=await f.welcome();const before=f.billing.db.prepare('SELECT payload FROM deliveries').get().payload;
  assert.throws(()=>createOnboarding({db:f.billing.db,stripe:f.stripe,delivery:f.billing.onboardingDelivery,config:f.config,key:randomBytes(32)}),/outbox_key_changed/);
  assert.equal(f.billing.db.prepare('SELECT payload FROM deliveries').get().payload,before);
  assert.ok(await f.ownership(token));
 }finally{await f.close()}
});

test('migração 002 preserva contas, credenciais, convites administrativos e entregas preparados na versão 001',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'omni-onboard-migration-'));let billing;
 try{
  billing=createBilling({stripe:{},resend:null,config:{projectRoot:root,dbPath:path.join(dir,'billing.sqlite'),emailEnabled:false}});
  const db=billing.db,sql=await (await import('node:fs/promises')).readFile(new URL('../db/migrations/001-licensing.sql',import.meta.url),'utf8');
  db.exec(sql);db.exec('CREATE TABLE auth_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');db.prepare('INSERT INTO auth_schema_migrations VALUES(1,?)').run(Date.now());
  db.prepare('INSERT INTO auth_accounts VALUES(?,?,?,?)').run('old-account','Existing','active',Date.now());
  db.prepare('INSERT INTO auth_credentials VALUES(?,?,?,?,?,?)').run('old-passkey','old-account',Buffer.from('PUBLIC TEST KEY'),1,'[]',Date.now());
  db.prepare('INSERT INTO auth_claims VALUES(?,?,?,?,NULL,?)').run('admin-hash','cus_Legacy','test',Date.now()+600000,'support-verified');
  const payload='{"subject":"existing immutable delivery"}';db.prepare('INSERT INTO deliveries(subscription_id,customer_id,invoice_id,payload,status) VALUES(?,?,?,?,?)').run('old-sub','cus_Legacy','old-invoice',payload,'retry');
  migrateLicensing(db);migrateLicensing(db);
  assert.equal(db.prepare('SELECT id FROM auth_accounts').get().id,'old-account');assert.equal(db.prepare('SELECT id FROM auth_credentials').get().id,'old-passkey');assert.equal(db.prepare('SELECT token_hash FROM auth_claims').get().token_hash,'admin-hash');assert.equal(db.prepare('SELECT payload FROM deliveries').get().payload,payload);
  assert.equal(db.prepare('SELECT count(*) n FROM auth_schema_migrations').get().n,2);
 }finally{billing?.close();await rm(dir,{recursive:true,force:true});}
});
