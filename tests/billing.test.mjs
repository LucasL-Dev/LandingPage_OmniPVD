import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { createBilling } from '../billing/service.mjs';
import { createApp } from '../server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'omnipvd-billing-'));
  // Fixture binária de teste; nunca é enviada por e-mail real ou publicada.
  await writeFile(path.join(dir, 'test.exe'), 'TEST INSTALLER FIXTURE');
  let clock = Date.now();
  const invoices = new Map();
  const initial = { id: 'in_initial', customer: 'cus_1', status: 'paid', paid: true, billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_1' } }, amount_paid: 7990, currency: 'brl', created: Math.floor(clock/1000), lines: { data: [{period:{end:Math.floor(clock/1000)+86400*30}}] } };
  invoices.set(initial.id, initial);
  const sub = { id: 'sub_1', status: 'active', customer: { id: 'cus_1', name: 'Ana', email: 'ana@example.invalid' }, latest_invoice: initial, items: { data: [{price:{id:'price_configured',product:{name:'OmniPVD'},recurring:{interval:'month',interval_count:1}}}] } };
  const calls = [];
  let fail = false;
  const stripe = { subscriptions: {retrieve:async()=>structuredClone(sub)}, invoices:{retrieve:async id=>structuredClone(invoices.get(id))} };
  const resend = { emails: { send: async(payload, options)=>{
    calls.push({payload, options:{idempotencyKey:options.idempotencyKey}});
    if(fail)throw new Error('uncertain network delivery');
    return {data:{id:'email_1'},error:null};
  } } };
  const config = { projectRoot: root, dbPath:path.join(dir,'billing.sqlite'), emailEnabled:true, downloadEnabled:true, installerPath:path.join(dir,'test.exe'), downloadOrigin:'https://download.example.invalid',priceId:'price_configured',from:'OmniPVD <sender@example.invalid>', supportEmail:'support@example.invalid' };
  let billing = createBilling({stripe,resend,config,now:()=>clock});
  const event=(eid,type='invoice.paid',oid='in_initial')=>({id:eid,type,livemode:false,data:{object:{id:oid}}});
  return {dir,config,stripe,resend,calls,sub,initial,invoices,event,get billing(){return billing},setFail:v=>fail=v,advance:ms=>clock+=ms,reopen(){billing.close();billing=createBilling({stripe,resend,config,now:()=>clock})},async close(){billing.close();await rm(dir,{recursive:true,force:true})}};
}

test('pagamento pendente, recusado e Checkout completo não enviam boas-vindas', async()=>{
 const f=await fixture();try{
  f.initial.status='open';f.initial.paid=false;
  await f.billing.receive(f.event('evt_pending'));await f.billing.runQueue();
  await f.billing.receive(f.event('evt_failed','invoice.payment_failed'));await f.billing.runQueue();
  await f.billing.receive(f.event('evt_checkout','checkout.session.completed','cs_1'));await f.billing.runQueue();
  assert.equal(f.calls.length,0);assert.equal(f.billing.db.prepare('SELECT count(*) n FROM deliveries').get().n,0);
 }finally{await f.close()}
});
test('eventos duplicados e distintos da mesma fatura enviam só uma vez, inclusive após reinício', async()=>{
 const f=await fixture();try{
  await f.billing.receive(f.event('evt_paid'));await f.billing.receive(f.event('evt_paid'));
  await f.billing.receive(f.event('evt_second'));await f.billing.runQueue();
  f.reopen();await f.billing.receive(f.event('evt_third'));await f.billing.runQueue();
  assert.equal(f.calls.length,1);assert.ok(f.calls[0].payload.html.includes('Ana'));
  assert.equal(f.billing.db.prepare('SELECT status FROM deliveries').get().status,'sent');
 }finally{await f.close()}
});
test('renovações não enviam boas-vindas; cancelamento e eventos antigos não reativam acesso',async()=>{
 const f=await fixture();try{
  const renewal={...f.initial,id:'in_renewal',billing_reason:'subscription_cycle'};f.invoices.set(renewal.id,renewal);f.sub.latest_invoice=renewal;
  await f.billing.receive(f.event('evt_renewal','invoice.paid',renewal.id));await f.billing.runQueue();assert.equal(f.calls.length,0);
  f.sub.status='canceled';await f.billing.receive(f.event('evt_cancel','customer.subscription.deleted','sub_1'));
  await f.billing.receive(f.event('evt_old_initial'));await f.billing.runQueue();assert.equal(f.calls.length,0);
  assert.equal(f.billing.db.prepare('SELECT status FROM subscriptions').get().status,'canceled');
 }finally{await f.close()}
});
test('falha de pagamento revoga a autorização; recuperação paga restaura sem boas-vindas de renovação',async()=>{
 const f=await fixture();try{
  const renewal={...f.initial,id:'in_renewal',billing_reason:'subscription_cycle',status:'open',paid:false};f.invoices.set(renewal.id,renewal);f.sub.latest_invoice=renewal;f.sub.status='past_due';
  await f.billing.receive(f.event('evt_failed','invoice.payment_failed',renewal.id));assert.equal(f.billing.db.prepare('SELECT status FROM subscriptions').get().status,'blocked');
  renewal.status='paid';renewal.paid=true;f.sub.status='active';await f.billing.receive(f.event('evt_recovered','invoice.paid',renewal.id));await f.billing.runQueue();assert.equal(f.calls.length,0);assert.equal(f.billing.db.prepare('SELECT status FROM subscriptions').get().status,'active');
 }finally{await f.close()}
});
test('retries persistem o mesmo payload e chave; depois de 23h exigem revisão',async()=>{
 const f=await fixture();try{
  await f.billing.receive(f.event('evt_paid'));f.setFail(true);await f.billing.runQueue();
  f.reopen();f.advance(61_000);await f.billing.runQueue();
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);
  f.advance(24*3600_000);await f.billing.runQueue();assert.equal(f.calls.length,2);assert.equal(f.billing.db.prepare('SELECT status FROM deliveries').get().status,'manual_review');
 }finally{await f.close()}
});
test('envio fica desligado sem habilitação ou sem instalador privado',async()=>{
 const f=await fixture();try{
  await f.billing.receive(f.event('evt_paid'));f.config.emailEnabled=false;await f.billing.runQueue();assert.equal(f.calls.length,0);
  f.config.emailEnabled=true;f.config.installerPath=path.join(f.dir,'missing.exe');await assert.rejects(f.billing.runQueue());assert.equal(f.calls.length,0);
 }finally{await f.close()}
});
test('webhook exige assinatura sobre o corpo original; download expira e exige assinatura ativa',async()=>{
 const f=await fixture();let server;try{
  const sdk=new Stripe('sk_test_not_a_real_key');f.stripe.webhooks=sdk.webhooks;
  process.env.STRIPE_WEBHOOK_SECRET='whsec_local_test_fixture';
  server=createApp(f.stripe,f.billing);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const body=JSON.stringify(f.event('evt_http'));
  const signature=sdk.webhooks.generateTestHeaderString({payload:body,secret:process.env.STRIPE_WEBHOOK_SECRET});
  const post=(payload,header=signature)=>fetch(base+'/api/stripe/webhook',{method:'POST',body:payload,headers:{'stripe-signature':header}});
  assert.equal((await post(body,'bad')).status,400);assert.equal((await post(body+' ')).status,400);
  assert.equal((await post(body)).status,200);await f.billing.runQueue();assert.equal(f.calls.length,1);
  const link=f.calls[0].payload.text.match(/https:\/\/\S+/)[0];const url=base+new URL(link).pathname+new URL(link).search;
  const downloaded=await fetch(url);assert.equal(downloaded.status,200);assert.equal(await downloaded.text(),'TEST INSTALLER FIXTURE');
  f.sub.status='canceled';assert.equal((await fetch(url)).status,403);
  f.sub.status='active';f.advance(49*3600_000);assert.equal((await fetch(url)).status,403);
  const live=JSON.stringify({...f.event('evt_live'),livemode:true});const sig=sdk.webhooks.generateTestHeaderString({payload:live,secret:process.env.STRIPE_WEBHOOK_SECRET});assert.equal((await post(live,sig)).status,400);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await f.close()}
});

test('pagamento inicial recuperado gera uma única entrega e outro Price não autoriza', async()=>{
 const f=await fixture();try{
  f.initial.status='open';f.initial.paid=false;f.sub.status='incomplete';
  await f.billing.receive(f.event('evt_initial_failed','invoice.payment_failed'));await f.billing.runQueue();assert.equal(f.calls.length,0);
  f.initial.status='paid';f.initial.paid=true;f.sub.status='active';
  f.sub.items.data[0].price.id='price_other';await f.billing.receive(f.event('evt_other_price'));await f.billing.runQueue();assert.equal(f.calls.length,0);
  f.sub.items.data[0].price.id=f.config.priceId;await f.billing.receive(f.event('evt_initial_recovered'));await f.billing.runQueue();assert.equal(f.calls.length,1);
 }finally{await f.close()}
});

test('download limits reject oversized installer and parallel streams; worker stop preserves pending jobs',async()=>{
 const f=await fixture();let server;
 try{
  await f.billing.receive(f.event('evt_limit'));f.config.maxInstallerBytes=1;
  await assert.rejects(f.billing.runQueue());assert.equal(f.calls.length,0);
  f.config.maxInstallerBytes=100000;await f.billing.runQueue();
  const token=new URL(f.calls[0].payload.html.match(/https:\/\/download[^"\s<]+/)[0].replaceAll('&amp;','&')).searchParams.get('token');
  // A held response exercises the connection cap before any provider call.
  const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');const response=new PassThrough();response.resume();response.setHeader=()=>{};response.writeHead=()=>response;
  f.config.maxDownloads=1;const held=f.billing.download({method:'GET',url:'/api/download?token='+token},response);
  let status;const other=new EventEmitter();other.setHeader=()=>{};other.writeHead=s=>{status=s;return other;};other.end=()=>{};
  await f.billing.download({method:'GET',url:'/api/download?token='+token},other);assert.equal(status,503);
  const finished=new Promise(r=>response.once('finish',r));await held;await finished;
  f.billing.stopQueue();const count=f.calls.length;await f.billing.runQueue();assert.equal(f.calls.length,count);
 }finally{await f.close();}
});
