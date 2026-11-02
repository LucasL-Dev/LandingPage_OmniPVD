import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers/onboarding.mjs';
const secret=()=>randomBytes(32).toString('base64url');
const address='buyer@example.invalid';
async function paid(f) { await f.pay();await f.billing.runQueue(); }
async function request(f,email=address,binding=secret(),session=null) {
 const input={email,requestKey:secret()},result=await f.emailOtp.start(input,binding,session);
 await f.billing.runQueue();return {input,binding,...result};
}
async function login(f,session=null) {const flow=await request(f,address,secret(),session);return f.emailOtp.verify({requestId:flow.requestId,code:f.loginCode()},flow.binding,session);}

test('OTP: compra confirmada, cadastro sem convite/passkey, consentimento PKCE e licença autorizada',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);assert.ok(!f.calls[0].payload.text.includes('#invite='));assert.ok(f.calls[0].payload.text.includes('/api/download?token='));
  const result=await login(f);assert.ok(result.browserToken);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_credentials').get().n,0);
  const tokens=f.desktop(result.browserToken);assert.equal((await f.licensing.status(f.auth.accessSession(tokens.access_token))).authorized,true);
  assert.equal(f.billing.db.prepare('SELECT customer_id FROM auth_stripe_links').get().customer_id,'cus_A');
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_claims').get().n,0);
 }finally{await f.close()}
});

test('OTP: código incorreto, cinco tentativas, expiração e replay falham sem criar contas',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);const flow=await request(f),code=f.loginCode(),wrong=code==='000000'?'111111':'000000';
  for(let i=0;i<5;i++)await assert.rejects(f.emailOtp.verify({requestId:flow.requestId,code:wrong},flow.binding),/invalid_verification/);
  await assert.rejects(f.emailOtp.verify({requestId:flow.requestId,code},flow.binding),/invalid_verification/);
  const expired=await request(f);f.advance(600001);await assert.rejects(f.emailOtp.verify({requestId:expired.requestId,code:f.loginCode()},expired.binding),/invalid_verification/);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,0);
  const valid=await request(f),validCode=f.loginCode();await f.emailOtp.verify({requestId:valid.requestId,code:validCode},valid.binding);
  await assert.rejects(f.emailOtp.verify({requestId:valid.requestId,code:validCode},valid.binding),/invalid_verification/);
 }finally{await f.close()}
});

test('OTP: pedido idempotente, falha Resend e reinício preservam código e payload cifrado',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);f.setFail(true);const flow=await request(f);const failed=f.calls.at(-1);
  assert.equal((await f.emailOtp.start(flow.input,flow.binding)).requestId,flow.requestId);
  assert.equal(f.billing.db.prepare("SELECT count(*) n FROM onboarding_outbox WHERE purpose='login'").get().n,1);
  const row=f.billing.db.prepare("SELECT payload_cipher FROM onboarding_outbox WHERE purpose='login'").get();assert.ok(!row.payload_cipher.includes(f.loginCode()));
  const dbCode=f.billing.db.prepare('SELECT code_hmac FROM auth_email_challenges').get().code_hmac;assert.notEqual(dbCode,f.loginCode());
  await f.reopen();f.advance(61000);f.setFail(false);await f.billing.runQueue();assert.deepEqual(f.calls.at(-1),failed);
  await f.emailOtp.verify({requestId:flow.requestId,code:f.loginCode()},flow.binding);
 }finally{await f.close()}
});

test('OTP: compra pendente, endereço desconhecido e conta legada recebem resposta genérica sem login',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  f.initial.paid=false;f.initial.status='open';await paid(f);assert.equal(f.calls.length,0);
  const a=await request(f),b=await request(f,'unknown@example.invalid');assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort());assert.equal(f.calls.length,0);
  await assert.rejects(f.emailOtp.verify({requestId:a.requestId,code:'123456'},a.binding),/invalid_verification/);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,0);
 }finally{await f.close()}
});

test('OTP: assinatura cancelada pode autenticar conta, mas nunca autoriza licença',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);f.subs.get('sub_cus_A').status='canceled';const browser=await login(f),tokens=f.desktop(browser.browserToken);
  const status=await f.licensing.status(f.auth.accessSession(tokens.access_token));assert.equal(status.authorized,false);assert.equal(status.offline_authorization,null);
 }finally{await f.close()}
});

test('OTP: conta antiga exige passkey/sessão recente e adesão explícita, preservando ID e vínculos',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);const claim=f.auth.issueClaim('cus_A','verified-migration'),legacy=await f.register(claim),before=f.calls.length;
  const blocked=await request(f);assert.equal(f.calls.length,before);
  await assert.rejects(f.emailOtp.verify({requestId:blocked.requestId,code:'123456'},blocked.binding),/invalid_verification/);
  const session=f.auth.browserSession(legacy.browserToken),enroll=await request(f,address,secret(),session),code=f.loginCode();
  await assert.rejects(f.emailOtp.verify({requestId:enroll.requestId,code},enroll.binding),/invalid_verification/);
  const enrolled=await f.emailOtp.verify({requestId:enroll.requestId,code},enroll.binding,session);assert.equal(enrolled.session.account_id,legacy.session.account_id);
  assert.equal((await login(f)).session.account_id,legacy.session.account_id);assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,1);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_credentials').get().n,1);
 }finally{await f.close()}
});

test('OTP: código de outro comprador, binding errado e troca do e-mail da fatura não reivindicam compras',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);f.addBuyer('cus_B','second@example.invalid');await f.pay('cus_B');await f.billing.runQueue();
  const a=await request(f),aCode=f.loginCode(),b=await request(f,'second@example.invalid');
  await assert.rejects(f.emailOtp.verify({requestId:b.requestId,code:aCode},a.binding),/invalid_verification/);
  await assert.rejects(f.emailOtp.verify({requestId:a.requestId,code:aCode},secret()),/invalid_verification/);
  f.initial.customer_email='attacker@example.invalid';await assert.rejects(f.emailOtp.verify({requestId:a.requestId,code:aCode},a.binding),/invalid_invite/);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,0);
 }finally{await f.close()}
});

test('OTP: mesmas caixas postais não mesclam clientes distintos; mudança concorrente impede vínculo',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);const flow=await request(f),code=f.loginCode();const old=f.auth.issueClaim('cus_A','support-race');await f.register(old);
  await assert.rejects(f.emailOtp.verify({requestId:flow.requestId,code},flow.binding),/invalid_verification/);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_email_identities').get().n,0);
  f.addBuyer('cus_B',address);await f.pay('cus_B');await f.billing.runQueue();
  const before=f.calls.length;await request(f);assert.equal(f.calls.length,before);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_stripe_links').get().n,1);
 }finally{await f.close()}
});

test('OTP: sessão persiste, refresh roda, replay revoga e logout impede nova licença',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);const browser=await login(f),tokens=f.desktop(browser.browserToken);await f.reopen();
  assert.ok(f.auth.browserSession(browser.browserToken));assert.ok(f.auth.accessSession(tokens.access_token));
  const refreshed=f.auth.exchange({client_id:'omnipvd-desktop',grant_type:'refresh_token',refresh_token:tokens.refresh_token});assert.ok(f.auth.accessSession(refreshed.access_token));
  assert.throws(()=>f.auth.exchange({client_id:'omnipvd-desktop',grant_type:'refresh_token',refresh_token:tokens.refresh_token}),/invalid_grant/);
  assert.throws(()=>f.auth.accessSession(refreshed.access_token),/invalid_session/);
  f.auth.revoke(f.auth.browserSession(browser.browserToken));assert.throws(()=>f.auth.browserSession(browser.browserToken),/invalid_session/);
 }finally{await f.close()}
});

test('OTP: limites por destinatário, envio obsoleto e indisponibilidade Stripe falham fechados',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);const flow=await request(f),code=f.loginCode();
  f.stripe.invoices.retrieve=async()=>{throw Error('private stripe failure');};await assert.rejects(f.emailOtp.verify({requestId:flow.requestId,code},flow.binding));
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,0);
  await request(f);await request(f);await assert.rejects(request(f),/rate_limited/);
  f.advance(600001);await f.billing.runQueue();assert.equal(f.billing.db.prepare("SELECT count(*) n FROM onboarding_outbox WHERE purpose='login' AND status='expired'").get().n,2);
 }finally{await f.close()}
});

test('OTP HTTP: origem exata, cookie de vinculação, adesão com CSRF e sessão HttpOnly segura',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);const base=await f.listen();
  const post=(path,data,{origin=f.config.origin,cookie='',csrf=''}={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify(data)});
  const input={email:address,requestKey:secret()},path='/api/auth/email-otp/request';
  assert.equal((await post(path,input,{origin:'https://omnipdv.com.br'})).status,403);
  const sent=await post(path,input);assert.equal(sent.status,200);assert.equal(sent.headers.get('Access-Control-Allow-Origin'),null);
  const cookie=sent.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);
  const data=await sent.json();await f.billing.runQueue();const verify={requestId:data.requestId,code:f.loginCode()};
  assert.equal((await post('/api/auth/email-otp/verify',verify)).status,400);
  const result=await post('/api/auth/email-otp/verify',verify,{cookie:cookie.split(';')[0]});assert.equal(result.status,200);
  const sessionCookie=result.headers.getSetCookie().find(c=>c.startsWith('omnipvd_browser=')).split(';')[0];assert.ok(sessionCookie);
  const sessionResponse=await fetch(base+'/api/auth/session',{headers:{Cookie:sessionCookie}}),session=await sessionResponse.json();assert.ok(session.csrf_token);
  assert.equal((await post('/api/auth/email-otp/enroll/request',input,{cookie:sessionCookie})).status,403);
  assert.equal((await post('/api/auth/logout',{}, {cookie:sessionCookie,csrf:session.csrf_token})).status,200);
  assert.equal((await fetch(base+'/api/auth/session',{headers:{Cookie:sessionCookie}})).status,401);
 }finally{await f.close()}
});

test('OTP HTTP: flag desligada preserva passkeys e não disponibiliza autenticação por código',async()=>{
 const f=await fixture();try {
  const base=await f.listen();assert.deepEqual(await (await fetch(base+'/api/auth/config')).json(),{email_otp_enabled:false});
  assert.equal((await fetch(base+'/api/auth/email-otp/request',{method:'POST',headers:{'Content-Type':'application/json',Origin:f.config.origin},body:JSON.stringify({email:address,requestKey:secret()})})).status,503);
  const result=await f.register(f.auth.issueClaim('cus_A','legacy-passkey-untouched'));assert.ok(result.browserToken);
 }finally{await f.close()}
});

test('OTP HTTP: limite por IP inclui destinos diferentes e não confia em X-Forwarded-For',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  const base=await f.listen();
  for(let i=0;i<10;i++)assert.equal((await fetch(base+'/api/auth/email-otp/request',{method:'POST',headers:{'Content-Type':'application/json',Origin:f.config.origin,'X-Forwarded-For':`192.0.2.${i}`},body:JSON.stringify({email:`unknown${i}@example.invalid`,requestKey:secret()})})).status,200);
  const denied=await fetch(base+'/api/auth/email-otp/request',{method:'POST',headers:{'Content-Type':'application/json',Origin:f.config.origin,'X-Forwarded-For':'192.0.2.90'},body:JSON.stringify({email:'other@example.invalid',requestKey:secret()})});assert.equal(denied.status,429);assert.ok(denied.headers.get('Retry-After'));
  assert.equal(f.calls.length,0);
 }finally{await f.close()}
});

test('OTP: concorrência de confirmações cria uma única conta; conta bloqueada e adesão revogada falham',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);const a=await request(f),code=f.loginCode();
  const results=await Promise.allSettled([f.emailOtp.verify({requestId:a.requestId,code},a.binding),f.emailOtp.verify({requestId:a.requestId,code},a.binding)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,1);
  const owner=results.find(x=>x.status==='fulfilled').value,session=f.auth.browserSession(owner.browserToken);
  const enroll=await request(f,address,secret(),session);f.auth.revoke(session);
  await assert.rejects(f.emailOtp.verify({requestId:enroll.requestId,code:f.loginCode()},enroll.binding,session),/invalid_session/);
  f.billing.db.prepare("UPDATE auth_accounts SET status='blocked'").run();const before=f.calls.length;await request(f);assert.equal(f.calls.length,before);
 }finally{await f.close()}
});

test('OTP: compras ambíguas e e-mail já comprovado por outra conta não geram vinculação automática',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);f.addBuyer('cus_B',address);await f.pay('cus_B');await f.billing.runQueue();const before=f.calls.length;
  await request(f);assert.equal(f.calls.length,before);assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,0);
 }finally{await f.close()}
});

test('OTP: adesão de conta histórica importa somente fatura paga do cliente já vinculado',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  const legacy=await f.register(f.auth.issueClaim('cus_A','support-historical')),session=f.auth.browserSession(legacy.browserToken);
  await f.pay(); // Historical delivery exists, but no onboarding record or resend/backfill.
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM onboarding_purchases').get().n,0);
  const enrolled=await login(f,session);assert.equal(enrolled.session.account_id,session.account_id);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,1);
  assert.equal(f.billing.db.prepare('SELECT customer_id FROM onboarding_purchases').get().customer_id,'cus_A');
 }finally{await f.close()}
});

test('OTP: desativar flag interrompe mensagens OTP pendentes sem apagar sessões ou convites',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);await f.emailOtp.start({email:address,requestKey:secret()},secret());const before=f.calls.length;
  f.config.emailOtp=false;await f.billing.runQueue();assert.equal(f.calls.length,before);
  assert.equal(f.billing.db.prepare("SELECT status FROM onboarding_outbox WHERE purpose='login'").get().status,'pending');
 }finally{await f.close()}
});

test('OTP: configuração exige onboarding, valida flag e não aceita pagamentos live',async()=>{
 const {validateDeployment}=await import('../ops/config.mjs');
 assert.throws(()=>validateDeployment({EMAIL_OTP_AUTH_ENABLED:'true'}),/onboarding/);
 assert.throws(()=>validateDeployment({EMAIL_OTP_AUTH_ENABLED:'yes'}),/Flag inválida/);
 assert.throws(()=>validateDeployment({STRIPE_SECRET_KEY:'sk_live_fixture',EMAIL_OTP_AUTH_ENABLED:'false'}),/teste/);
});

test('OTP: novo login reutiliza conta e compra com mesmo endereço não é anexada automaticamente',async()=>{
 const f=await fixture({emailOtpEnabled:true});try {
  await paid(f);const first=await login(f);
  f.addBuyer('cus_B',address);await f.pay('cus_B');await f.billing.runQueue();const again=await login(f);
  assert.equal(first.session.account_id,again.session.account_id);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_accounts').get().n,1);
  assert.equal(f.billing.db.prepare('SELECT count(*) n FROM auth_stripe_links').get().n,1);
  assert.equal(f.billing.db.prepare('SELECT customer_id FROM auth_stripe_links').get().customer_id,'cus_A');
 }finally{await f.close()}
});
