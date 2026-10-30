import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, randomBytes, sign, createPublicKey } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { createBilling } from '../billing/service.mjs';
import { createAuth } from '../auth/service.mjs';
import { createLicensing, verifyOfflineLicense } from '../licensing/service.mjs';
import { createAuthHandler } from '../auth/http.mjs';
import { createApp } from '../server.mjs';
import { hash } from '../auth/common.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const b64=data=>Buffer.from(data).toString('base64url');
const sha=data=>createHash('sha256').update(data).digest();
const list=items=>({async *[Symbol.asyncIterator](){yield* items;}});
function authenticator() {
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=keys.publicKey.export({format:'jwk'}),credentialId=randomBytes(32);let counter=0;
 const cose=isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(jwk.x,'base64url'))],[-3,new Uint8Array(Buffer.from(jwk.y,'base64url'))]]));
 let handle;
 return {
  register(options,origin) {
   handle=options.user.id;
   const client=Buffer.from(JSON.stringify({type:'webauthn.create',challenge:options.challenge,origin,crossOrigin:false}));
   const length=Buffer.alloc(2);length.writeUInt16BE(credentialId.length);
   const authData=Buffer.concat([sha(options.rp.id),Buffer.from([0x45]),Buffer.alloc(4),Buffer.alloc(16),length,credentialId,cose]);
   return {id:b64(credentialId),rawId:b64(credentialId),type:'public-key',authenticatorAttachment:'platform',clientExtensionResults:{},response:{clientDataJSON:b64(client),attestationObject:b64(isoCBOR.encode(new Map([['fmt','none'],['authData',new Uint8Array(authData)],['attStmt',new Map()]]))),transports:['internal']}};
  },
  login(options,origin) {
   const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:options.challenge,origin,crossOrigin:false}));
   const count=Buffer.alloc(4);count.writeUInt32BE(++counter);
   const authData=Buffer.concat([sha(options.rpId),Buffer.from([0x05]),count]);
   return {id:b64(credentialId),rawId:b64(credentialId),type:'public-key',authenticatorAttachment:'platform',clientExtensionResults:{},response:{clientDataJSON:b64(client),authenticatorData:b64(authData),signature:b64(sign('sha256',Buffer.concat([authData,sha(client)]),keys.privateKey)),userHandle:handle}};
  },
 };
}
async function fixture(beforeAuth=()=>{}) {
 const dir=await mkdtemp(path.join(tmpdir(),'omnipvd-license-'));let clock=Date.now(),unavailable=false;
 const initial={id:'in_initial',customer:'cus_1',subscription:'sub_1',billing_reason:'subscription_create',status:'paid',paid:true,lines:{has_more:false,data:[{price:{id:'price_licensed'},subscription:'sub_1',period:{start:Math.floor(clock/1000)-60,end:Math.floor(clock/1000)+86400*30}}]}};
 const subscription={id:'sub_1',customer:'cus_1',livemode:false,status:'active',latest_invoice:initial,items:{has_more:false,data:[{price:{id:'price_licensed'}}]}};
 const invoices=[initial],subscriptions=[subscription];
 const stripe={subscriptions:{list:params=>{if(unavailable)throw new Error('private provider details');return list(subscriptions.filter(s=>s.customer===params.customer));},retrieve:async()=>structuredClone(subscription)},invoices:{retrieve:async id=>structuredClone(invoices.find(i=>i.id===id)),list:params=>list(invoices.filter(i=>i.customer===params.customer&&i.subscription===params.subscription)),listLineItems:()=>list(initial.lines.data)}};
 const dbPath=path.join(dir,'billing.sqlite');
 const billingConfig={projectRoot:root,dbPath,emailEnabled:false};
 let billing=createBilling({stripe,resend:null,config:billingConfig,now:()=>clock});
 beforeAuth(billing.db);
 const keys=generateKeyPairSync('ed25519');
 const config={origin:'https://accounts.example.invalid',rpId:'accounts.example.invalid',secureCookies:true,accessTtlMs:600_000,sessionTtlMs:30*86400_000,browserTtlMs:12*3600_000};
 let auth=createAuth({db:billing.db,config,now:()=>clock});
 let licensing=await createLicensing({db:billing.db,stripe,privateKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}),config:{priceId:'price_licensed',keyId:'test-1',issuer:config.origin,audience:'omnipvd-desktop',offlineTtlSeconds:14400,recheckSeconds:900},now:()=>clock});
 let server;
 return {dir,get billing(){return billing},config,stripe,initial,subscription,invoices,subscriptions,keys,get auth(){return auth},get licensing(){return licensing},advance:ms=>clock+=ms,setUnavailable:v=>unavailable=v,now:()=>clock,
  async enroll(customer='cus_1') {
   const claimToken=auth.issueClaim(customer,'verified-test-purchase');const device=authenticator();
   const flow=await auth.registrationOptions({claimToken,displayName:'Cliente de teste'});
   const response=device.register(flow.options,config.origin);
   const result=await auth.registrationVerify({claimToken,flowToken:flow.flowToken,response});
   return {...result,device,claimToken};
  },
  desktop(browserToken,params={}) {
   const verifier=b64(randomBytes(48));const input={client_id:'omnipvd-desktop',response_type:'code',redirect_uri:'http://127.0.0.1:54321/omnipvd/callback',code_challenge_method:'S256',code_challenge:hash(verifier),state:b64(randomBytes(32)),installation_id:b64(randomBytes(24)),...params};
   const result=auth.authorize(auth.browserSession(browserToken),input);
   const code=new URL(result.redirect_uri).searchParams.get('code');
   const exchange={client_id:input.client_id,grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:input.redirect_uri};
   return {tokens:auth.exchange(exchange),exchange,input};
  },
  async reopen(){
   // Close and reopen the actual database file, as on a server restart.
   billing.close();billing=createBilling({stripe,resend:null,config:billingConfig,now:()=>clock});
   auth=createAuth({db:billing.db,config,now:()=>clock});
   licensing=await createLicensing({db:billing.db,stripe,privateKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}),config:{priceId:'price_licensed',keyId:'test-1',issuer:config.origin,audience:'omnipvd-desktop',offlineTtlSeconds:14400,recheckSeconds:900},now:()=>clock});
  },
  async listen(){const identity={handle:createAuthHandler({auth,licensing,db:billing.db,config,now:()=>clock})};server=createApp(stripe,billing,identity);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;},
  async close(){if(server)await new Promise(resolve=>server.close(resolve));billing.close();await rm(dir,{recursive:true,force:true});}
 };
}

test('passkey verificada, PKCE e assinatura ativa autorizam somente a conta vinculada',async()=>{
 const f=await fixture();try{
  const enrolled=await f.enroll();const {tokens}=f.desktop(enrolled.browserToken);
  const result=await f.licensing.status(f.auth.accessSession(tokens.access_token));
  assert.equal(result.authorized,true);assert.equal(result.subscription_status,'active');assert.ok(!JSON.stringify(result).includes('cus_1'));
  const verified=await verifyOfflineLicense(result.offline_authorization,{publicKey:f.keys.publicKey,issuer:f.config.origin,audience:'omnipvd-desktop',installationId:tokens.installation_id,accountId:tokens.account_id,sessionId:tokens.session_id,now:new Date(f.now())});
  assert.equal(verified.authorized,true);
  const outsider=await f.enroll('cus_other');const other=f.desktop(outsider.browserToken).tokens;
  assert.equal((await f.licensing.status(f.auth.accessSession(other.access_token))).authorized,false);
 }finally{await f.close()}
});

test('sem assinatura, cancelamento, expiração, recusa e falta de pagamento inicial não autorizam',async()=>{
 const f=await fixture();try{
  const {tokens}=f.desktop((await f.enroll()).browserToken);const session=()=>f.auth.accessSession(tokens.access_token);
  for(const state of ['canceled','past_due','unpaid','incomplete','paused','trialing']){f.subscription.status=state;const result=await f.licensing.status(session());assert.equal(result.authorized,false,state);assert.equal(result.offline_authorization,null);}
  f.subscription.status='active';f.initial.lines.data[0].period.end=Math.floor(f.now()/1000)-1;
  assert.equal((await f.licensing.status(session())).subscription_status,'expired');
  f.initial.status='open';f.initial.paid=false;
  assert.equal((await f.licensing.status(session())).authorized,false);
  f.subscriptions.length=0;assert.equal((await f.licensing.status(session())).subscription_status,'no_subscription');
 }finally{await f.close()}
});

test('renovação paga estende licença, falha nega e evento antigo não é fonte de autorização',async()=>{
 const f=await fixture();try{
  const {tokens}=f.desktop((await f.enroll()).browserToken);const session=f.auth.accessSession(tokens.access_token);
  const renewal={...structuredClone(f.initial),id:'in_renewal',billing_reason:'subscription_cycle',status:'open',paid:false};
  f.invoices.push(renewal);f.subscription.latest_invoice=renewal;f.subscription.status='past_due';
  assert.equal((await f.licensing.status(session)).authorized,false);
  renewal.status='paid';renewal.paid=true;f.subscription.status='active';renewal.lines.data[0].period.end+=86400*30;
  const result=await f.licensing.status(session);assert.equal(result.authorized,true);
  assert.equal(f.billing.db.prepare('SELECT initial_invoice_id FROM license_entitlements').get().initial_invoice_id,'in_initial');
  assert.equal(f.billing.db.prepare('SELECT paid_until FROM license_entitlements').get().paid_until,renewal.lines.data[0].period.end);
  f.subscription.cancel_at_period_end=true;assert.equal((await f.licensing.status(session)).authorized,true);
  f.subscription.status='canceled';assert.equal((await f.licensing.status(session)).authorized,false);
 }finally{await f.close()}
});

test('token inválido, expirado, sessão revogada e conta bloqueada são rejeitados',async()=>{
 const f=await fixture();try{
  const {tokens}=f.desktop((await f.enroll()).browserToken);
  assert.throws(()=>f.auth.accessSession('invalid'),/invalid_session/);
  f.advance(601_000);assert.throws(()=>f.auth.accessSession(tokens.access_token),/invalid_session/);
  const refreshed=f.auth.exchange({client_id:'omnipvd-desktop',grant_type:'refresh_token',refresh_token:tokens.refresh_token});
  const session=f.auth.accessSession(refreshed.access_token);f.auth.revoke(session);assert.throws(()=>f.auth.accessSession(refreshed.access_token),/invalid_session/);
  f.billing.db.prepare("UPDATE auth_accounts SET status='disabled' WHERE id=?").run(tokens.account_id);
  assert.throws(()=>f.auth.exchange({client_id:'omnipvd-desktop',grant_type:'refresh_token',refresh_token:refreshed.refresh_token}),/invalid_session/);
 }finally{await f.close()}
});

test('refresh rotativo persiste; reutilização revoga a família sem rollback da revogação',async()=>{
 const f=await fixture();try{
  const {tokens}=f.desktop((await f.enroll()).browserToken);await f.reopen();
  assert.equal(f.auth.accessSession(tokens.access_token).account_id,tokens.account_id);
  const rotated=f.auth.exchange({client_id:'omnipvd-desktop',grant_type:'refresh_token',refresh_token:tokens.refresh_token});
  assert.throws(()=>f.auth.exchange({client_id:'omnipvd-desktop',grant_type:'refresh_token',refresh_token:tokens.refresh_token}),/invalid_grant/);
  assert.throws(()=>f.auth.accessSession(rotated.access_token),/invalid_session/);
 }finally{await f.close()}
});

test('passkeys exigem origem, assinatura e desafio corretos; convites e códigos não podem ser reutilizados',async()=>{
 const f=await fixture();try{
  const enrollment=await f.enroll();
  await assert.rejects(f.auth.registrationOptions({claimToken:enrollment.claimToken,displayName:'Ataque'}),/invalid_claim/);
  const flow=await f.auth.loginOptions();const bad=enrollment.device.login(flow.options,'https://attacker.example.invalid');
  await assert.rejects(f.auth.loginVerify({flowToken:flow.flowToken,response:bad}),/passkey_verification_failed/);
  const goodFlow=await f.auth.loginOptions();const response=enrollment.device.login(goodFlow.options,f.config.origin);
  const signedIn=await f.auth.loginVerify({flowToken:goodFlow.flowToken,response});assert.ok(signedIn.browserToken);
  await assert.rejects(f.auth.loginVerify({flowToken:goodFlow.flowToken,response}),/invalid_challenge/);
  const desktop=f.desktop(signedIn.browserToken);assert.throws(()=>f.auth.exchange(desktop.exchange),/invalid_grant/);
  assert.throws(()=>f.desktop(signedIn.browserToken,{redirect_uri:'https://attacker.example.invalid/callback'}),/invalid_redirect/);
  const token=f.auth.issueClaim('cus_expired','verified');f.advance(31*60_000);await assert.rejects(f.auth.registrationOptions({claimToken:token,displayName:'Expired'}),/invalid_claim/);
 }finally{await f.close()}
});

test('autorização offline rejeita adulteração, outra instalação e validade ampliada; falha Stripe não emite nova licença',async()=>{
 const f=await fixture();try{
  const {tokens}=f.desktop((await f.enroll()).browserToken);const session=f.auth.accessSession(tokens.access_token);
  const result=await f.licensing.status(session);
  const options={publicKey:createPublicKey(f.keys.privateKey),issuer:f.config.origin,audience:'omnipvd-desktop',installationId:tokens.installation_id,accountId:tokens.account_id,sessionId:tokens.session_id,now:new Date(f.now())};
  await assert.rejects(verifyOfflineLicense(result.offline_authorization,{...options,installationId:'other-installation'}));
  const parts=result.offline_authorization.split('.');parts[1]=b64(JSON.stringify({...JSON.parse(Buffer.from(parts[1],'base64url')),exp:9999999999}));
  await assert.rejects(verifyOfflineLicense(parts.join('.'),options));
  f.setUnavailable(true);await assert.rejects(f.licensing.status(session),/license_unavailable/);
  await verifyOfflineLicense(result.offline_authorization,options);
  await assert.rejects(verifyOfflineLicense(result.offline_authorization,{...options,now:new Date(f.now()+14401_000)}));
 }finally{await f.close()}
});

test('HTTP não permite consultar outra conta, exige CSRF e limita requisições; falhas não vazam detalhes',async()=>{
 const f=await fixture();try{
  const enrolled=await f.enroll();const {tokens}=f.desktop(enrolled.browserToken);const base=await f.listen();
  const get=(suffix='',token=tokens.access_token)=>fetch(base+'/api/license/status'+suffix,{headers:{Authorization:'Bearer '+token}});
  assert.equal((await get()).status,200);assert.equal((await get('?customer_id=cus_other')).status,400);assert.equal((await get('','bad')).status,401);
  const headers={Origin:f.config.origin,'Content-Type':'application/json',Cookie:`omnipvd_browser=${enrolled.browserToken}`};
  assert.equal((await fetch(base+'/api/auth/sessions/revoke',{method:'POST',headers,body:JSON.stringify({session_id:tokens.session_id})})).status,403);
  f.setUnavailable(true);const fail=await get();assert.equal(fail.status,503);assert.ok(!(await fail.text()).includes('private provider details'));
  f.setUnavailable(false);let limited=false;for(let i=0;i<32;i++){const response=await get();if(response.status===429){limited=true;assert.equal(response.headers.get('Retry-After'),'60');break;}}assert.equal(limited,true);
 }finally{await f.close()}
});

test('migração aditiva preserva eventos, entregas e tokens existentes, e reaplicação não apaga sessões',async()=>{
 const f=await fixture(db=>{
  db.prepare('INSERT INTO events VALUES(?,?,?)').run('existing_event','invoice.paid',Date.now());
  db.prepare('INSERT INTO deliveries(subscription_id,customer_id,invoice_id,status,resend_id) VALUES(?,?,?,?,?)').run('existing_sub','existing_customer','existing_invoice','sent','existing_delivery');
  db.prepare('INSERT INTO downloads VALUES(?,?,?,?)').run('existing_token_hash','existing_sub','existing_customer',Date.now()+1000);
 });try{
  const {tokens}=f.desktop((await f.enroll()).browserToken);await f.reopen();
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM events WHERE id=?').get('existing_event').n,1);
  assert.equal(f.billing.db.prepare('SELECT resend_id FROM deliveries WHERE subscription_id=?').get('existing_sub').resend_id,'existing_delivery');
  assert.equal(f.billing.db.prepare('SELECT token_hash FROM downloads').get().token_hash,'existing_token_hash');
  assert.equal(f.auth.accessSession(tokens.access_token).account_id,tokens.account_id);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_schema_migrations').get().n,1);
 }finally{await f.close()}
});

test('PKCE incorreto e código expirado falham; revogação entre contas é proibida',async()=>{
 const f=await fixture();try{
  const a=await f.enroll(),b=await f.enroll('cus_second');
  const desktop=f.desktop(a.browserToken);const other=f.desktop(b.browserToken);
  const authorization=f.auth.authorize(a.session,desktop.input);const code=new URL(authorization.redirect_uri).searchParams.get('code');
  const input={...desktop.exchange,code};
  assert.throws(()=>f.auth.exchange({...input,code_verifier:'x'.repeat(64)}),/invalid_grant/);
  f.advance(61_000);assert.throws(()=>f.auth.exchange(input),/invalid_grant/);
  assert.throws(()=>f.auth.revoke(a.session,other.tokens.session_id),/session_not_found/);
  assert.equal(f.auth.accessSession(other.tokens.access_token).account_id,b.session.account_id);
  f.advance(31*86400_000);assert.throws(()=>f.auth.exchange({client_id:'omnipvd-desktop',grant_type:'refresh_token',refresh_token:other.tokens.refresh_token}),/invalid_grant/);
 }finally{await f.close()}
});

test('faturas da API atual e paginação usam somente o período do Price licenciado; offline não excede o período pago',async()=>{
 const f=await fixture();try{
  const {tokens}=f.desktop((await f.enroll()).browserToken);
  const end=Math.floor(f.now()/1000)+120;
  delete f.initial.subscription;f.initial.parent={subscription_details:{subscription:'sub_1'}};
  f.initial.lines={has_more:true,data:[]};
  f.stripe.invoices.list=()=>list([f.initial]);
  f.stripe.invoices.listLineItems=()=>list([
   {pricing:{price_details:{price:'price_other'}},parent:{subscription_item_details:{subscription:'sub_1',proration:false}},period:{start:Math.floor(f.now()/1000)-1,end:end+9999999}},
   {pricing:{price_details:{price:'price_licensed'}},parent:{subscription_item_details:{subscription:'sub_1',proration:false}},period:{start:Math.floor(f.now()/1000)-1,end}},
  ]);
  f.subscription.items.has_more=true;f.stripe.subscriptionItems={list:()=>list(f.subscription.items.data)};
  const result=await f.licensing.status(f.auth.accessSession(tokens.access_token));
  assert.equal(result.authorized,true);assert.equal(result.authorization_expires_at,new Date(end*1000).toISOString());
  assert.equal(f.billing.db.prepare('SELECT paid_until FROM license_entitlements').get().paid_until,end);
 }finally{await f.close()}
});

test('falha interna do backend responde 503 sem dados privados e sem autorização offline',async()=>{
 const f=await fixture();try{
  const {tokens}=f.desktop((await f.enroll()).browserToken);const base=await f.listen();
  f.licensing.status=async()=>{throw new Error('private backend information');};
  const response=await fetch(base+'/api/license/status',{headers:{Authorization:'Bearer '+tokens.access_token}});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'temporarily_unavailable'});
 }finally{await f.close()}
});

test('segredos de sessão persistem somente como hashes e novas passkeys exigem login recente',async()=>{
 const f=await fixture();try{
  const enrolled=await f.enroll();const {tokens}=f.desktop(enrolled.browserToken);
  const stored=JSON.stringify({claims:f.billing.db.prepare('SELECT * FROM auth_claims').all(),sessions:f.billing.db.prepare('SELECT * FROM auth_sessions').all(),access:f.billing.db.prepare('SELECT * FROM auth_access_tokens').all(),refresh:f.billing.db.prepare('SELECT * FROM auth_refresh_tokens').all()});
  for(const raw of [enrolled.claimToken,enrolled.browserToken,tokens.access_token,tokens.refresh_token])assert.ok(!stored.includes(raw));
  f.advance(301_000);await assert.rejects(f.auth.registrationOptions({},f.auth.browserSession(enrolled.browserToken)),/reauth_required/);
  const flow=await f.auth.loginOptions();const signedIn=await f.auth.loginVerify({flowToken:flow.flowToken,response:enrolled.device.login(flow.options,f.config.origin)});
  assert.ok((await f.auth.registrationOptions({},signedIn.session)).options.challenge);
 }finally{await f.close()}
});
