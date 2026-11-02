import { readFile } from 'node:fs/promises';

const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** Prepara o payload do Resend. Não faz requisições nem envia e-mails. */
export async function buildWelcomeEmail(data) {
  const fields = ['customerName', 'planName', 'price', 'billingPeriod', 'purchaseDate', 'downloadUrl', 'supportEmail'];
  const values = {};
  for (const field of fields) {
    if (typeof data?.[field] !== 'string' || !data[field].trim() || /[\r\n]/.test(data[field])) {
      throw new Error(`Campo obrigatório inválido: ${field}`);
    }
    values[field] = data[field].trim();
  }
  const url = new URL(values.downloadUrl);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    throw new Error('downloadUrl precisa ser uma URL HTTPS sem credenciais.');
  }
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(values.supportEmail)) {
    throw new Error('supportEmail inválido.');
  }
  let activationSection='',activationText='';
  if(data.activationUrl) {
    const activation=new URL(data.activationUrl);
    if(activation.protocol!=='https:' || activation.username || activation.password)throw Error('activationUrl deve ser HTTPS.');
    const otp=data.activationMode==='email-otp';
    const existing=data.activationMode==='login'||otp;
    const heading=existing?'Acesse sua conta OmniPDV':'Ative sua conta com segurança';
    const instructions=otp?'Após instalar, abra o acesso pelo navegador, informe o e-mail usado na compra e confirme o código de 6 dígitos enviado ao seu e-mail. Não é necessário criar senha ou passkey. Autorize somente o aplicativo Windows que você iniciou.':existing?'Entre com sua passkey existente e autorize o aplicativo Windows. Sua conta não será duplicada.':'Abra o convite pessoal, solicite o código enviado ao e-mail da compra, confirme o código e cadastre sua passkey. Depois, entre no aplicativo pelo navegador para validar sua licença.';
    activationSection=`<h2 style="margin:0 0 12px;font-size:21px;line-height:28px;color:#173F35;">${heading}</h2><p style="margin:0 0 18px;font-size:14px;line-height:23px;color:#53655E;">${instructions}</p><p style="margin:0 0 18px;"><a href="${escapeHtml(data.activationUrl)}" style="display:inline-block;background:#285D53;color:#FFFFFF;text-decoration:none;font-weight:bold;padding:14px 20px;border-radius:7px;">${existing?'Acessar minha conta':'Ativar minha conta'}</a></p><p style="margin:0 0 28px;font-size:12px;line-height:20px;color:#65776D;">${existing?'Não compartilhe suas credenciais.':'O convite expira em 48 horas, é pessoal e de uso único. Nunca compartilhe o código de e-mail. Se expirar, use a recuperação na página de ativação.'}</p>`;
    activationText=`\n\n${heading}\n${instructions}\n${data.activationUrl}\n${existing?'':'Convite pessoal de uso único, válido por 48 horas. Se expirar, solicite recuperação na página de ativação.'}`;
  }
  const [template, logo] = await Promise.all([
    readFile(new URL('./boas-vindas.html', import.meta.url), 'utf8'),
    readFile(new URL('../assets/omnipdv.png', import.meta.url)),
  ]);
  const html = template.replace(/{{(\w+)}}/g, (_, name) => {
    if (name === 'activationSection') return activationSection;
    if (!(name in values)) throw new Error(`Variável desconhecida: ${name}`);
    return escapeHtml(values[name]);
  });
  const text = `Olá, ${values.customerName}!\n\nSua assinatura do OmniPVD foi confirmada.\nPlano: ${values.planName}\nValor: ${values.price} / ${values.billingPeriod}\nContratação: ${values.purchaseDate}\n\nBaixar OmniPVD para Windows:\n${values.downloadUrl}\n\nWindows 10 ou 11, 64 bits. O link é temporário e pessoal; não compartilhe. Se expirar, fale com o suporte.\n\n1. Baixe e abra o instalador no Windows.\n2. Crie seu administrador no primeiro acesso.\n3. Cadastre produtos, confira preços e estoque e abra o caixa. A emissão fiscal exige configuração e validação próprias.\n\nNão é necessário instalar Node.js ou Git. Faça backup antes de atualizar e mantenha as proteções do Windows ativas.\n\nSuporte: ${values.supportEmail}\nInforme o e-mail utilizado na compra.\n\nOmniPVD — Uma nova perspectiva para o seu negócio.\nEste é um e-mail transacional. Se não reconhece a contratação, contate o suporte.`;
  return {
    subject: 'Bem-vindo ao OmniPVD — seu acesso está disponível',
    html,
    text: text + activationText,
    attachments: [{ filename: 'omnipvd.png', content: logo.toString('base64'), contentId: 'omnipvd-logo' }],
  };
}
