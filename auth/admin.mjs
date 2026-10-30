import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { billingRuntime } from '../billing/runtime.mjs';
import { authRuntime } from './runtime.mjs';
import { transaction } from './common.mjs';

try { loadEnvFile(); } catch(error) { if(error.code!=='ENOENT')throw error; }
const args=process.argv.slice(2),command=args.shift();
const option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:null;};
const stripe=process.env.STRIPE_SECRET_KEY?new Stripe(process.env.STRIPE_SECRET_KEY):null;
const root=fileURLToPath(new URL('../',import.meta.url));
const priceId=process.env.STRIPE_PRICE_ID || 'price_1UVCotRyOKs2Cpl0wvQXsmAi';
const billing=billingRuntime(stripe,root,priceId);
try {
 const identity=await authRuntime({stripe,billing,projectRoot:root,priceId});
 if(!identity)throw new Error('Configure o licenciamento antes de usar a ferramenta administrativa.');
 const reference=option('--verified-reference');
 if(!reference||reference.length<3||reference.length>200)throw new Error('Informe --verified-reference com a referência da verificação de titularidade.');
 if(command==='invite') {
  const customerId=option('--customer');
  if(!customerId||!/^cus_[A-Za-z0-9]+$/.test(customerId))throw new Error('Informe --customer com o cliente Stripe verificado.');
  const customer=await stripe.customers.retrieve(customerId);
  if(customer.deleted||customer.livemode!==false)throw new Error('Somente clientes existentes no modo teste são aceitos nesta fase.');
  const token=identity.auth.issueClaim(customerId,reference);
  const url=new URL('/account/login',process.env.AUTH_ORIGIN);url.hash=new URLSearchParams({invite:token}).toString();
  // Intentional single display to the trusted operator. Never send this to shared logs.
  console.log('Convite de uso único (30 minutos). Entregue apenas ao titular verificado, por canal seguro:');
  console.log(url.href);
 } else if(command==='disable' || command==='revoke-sessions') {
  const account=option('--account');
  if(!account||!billing.db.prepare('SELECT 1 FROM auth_accounts WHERE id=?').get(account))throw new Error('Conta não encontrada.');
  transaction(billing.db,()=>{
   if(command==='disable')billing.db.prepare("UPDATE auth_accounts SET status='disabled' WHERE id=?").run(account);
   billing.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').run(Date.now(),account);
   billing.db.prepare('INSERT INTO auth_audit(action,account_id,resource_id,created_at) VALUES(?,?,?,?)').run(command==='disable'?'account_disabled':'all_sessions_revoked',account,reference,Date.now());
  });
  console.log('Operação concluída. Autorizações offline já emitidas expiram no prazo assinado.');
 } else throw new Error('Use invite, disable ou revoke-sessions.');
} catch {
 console.error('Operação não concluída. Verifique a configuração, a conta, a referência de verificação e o acesso Stripe de teste. Nenhum detalhe privado será exibido.');
 process.exitCode=1;
} finally { billing?.close(); }
