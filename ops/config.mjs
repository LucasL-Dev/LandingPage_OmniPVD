import path from 'node:path';
export function validateDeployment(env=process.env) {
  const stage=env.DEPLOY_ENV || 'development';
  if(!['development','staging','production'].includes(stage))throw Error('DEPLOY_ENV inválido.');
  // Hosting in production does not enable live Stripe billing.
  if(env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith('sk_test_'))throw Error('Somente chave Stripe de teste é permitida nesta entrega.');
  const flags=['AUTH_ENABLED','AUTH_ALLOW_LOCALHOST','AUTO_WELCOME_EMAIL_ENABLED','PRIVATE_DOWNLOAD_ENABLED'];
  for(const flag of flags)if(env[flag] && !['true','false'].includes(env[flag]))throw Error(`Flag inválida: ${flag}`);
  const integer=(key,fallback,min,max)=>{const value=Number(env[key]||fallback);if(!Number.isSafeInteger(value)||value<min||value>max)throw Error(`Limite inválido: ${key}`);return value;};
  const port=integer('PORT',3000,1024,65535),maxDownloads=integer('MAX_CONCURRENT_DOWNLOADS',4,1,32),maxInstallerBytes=integer('MAX_INSTALLER_BYTES',2147483648,1,8589934592);
  const queueInterval=integer('QUEUE_INTERVAL_SECONDS',30,5,300)*1000;
  if(stage!=='development') {
    if(env.HOST!=='127.0.0.1')throw Error('VPS exige HOST=127.0.0.1 atrás do proxy HTTPS.');
    for(const key of ['DOMAIN','AUTH_ORIGIN','DOWNLOAD_ORIGIN']){
      let url;try{url=new URL(env[key]);}catch{throw Error(`Origem ausente: ${key}`);}
      if(url.protocol!=='https:'||url.origin!==env[key]||url.username||url.password)throw Error(`Origem HTTPS inválida: ${key}`);
    }
    if(env.DOMAIN!==env.AUTH_ORIGIN || env.DOMAIN!==env.DOWNLOAD_ORIGIN)throw Error('Checkout, passkeys e downloads devem usar a mesma origem estável.');
    if(env.AUTH_RP_ID!==new URL(env.AUTH_ORIGIN).hostname || env.AUTH_ALLOW_LOCALHOST!=='false')throw Error('Configure RP ID exato e desabilite localhost na VPS.');
    for(const key of ['BILLING_DB_PATH','LICENSE_PRIVATE_KEY_PATH'])if(!env[key]||!path.isAbsolute(env[key]))throw Error(`Caminho privado absoluto obrigatório: ${key}`);
    for(const key of ['STRIPE_SECRET_KEY','STRIPE_PRICE_ID','STRIPE_WEBHOOK_SECRET'])if(!env[key])throw Error(`Configuração obrigatória: ${key}`);
    if(env.AUTH_ENABLED!=='true')throw Error('A implantação da VPS exige AUTH_ENABLED=true.');
  }
  if(env.AUTO_WELCOME_EMAIL_ENABLED==='true' && (!env.RESEND_API_KEY||!env.RESEND_FROM||!env.SUPPORT_EMAIL||env.PRIVATE_DOWNLOAD_ENABLED!=='true'))throw Error('Worker Resend exige remetente, suporte, API e download privado configurados.');
  if(env.PRIVATE_DOWNLOAD_ENABLED==='true' && (!env.PRIVATE_INSTALLER_PATH||!path.isAbsolute(env.PRIVATE_INSTALLER_PATH)))throw Error('Instalador privado exige caminho absoluto.');
  return {stage,host:env.HOST||'127.0.0.1',port,maxDownloads,maxInstallerBytes,queueInterval};
}
