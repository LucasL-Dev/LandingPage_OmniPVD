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
  const [template, logo] = await Promise.all([
    readFile(new URL('./boas-vindas.html', import.meta.url), 'utf8'),
    readFile(new URL('../assets/omnipdv.png', import.meta.url)),
  ]);
  const html = template.replace(/{{(\w+)}}/g, (_, name) => {
    if (!(name in values)) throw new Error(`Variável desconhecida: ${name}`);
    return escapeHtml(values[name]);
  });
  const text = `Olá, ${values.customerName}!\n\nSua assinatura do OmniPVD foi confirmada.\nPlano: ${values.planName}\nValor: ${values.price} / ${values.billingPeriod}\nContratação: ${values.purchaseDate}\n\nBaixar OmniPVD para Windows:\n${values.downloadUrl}\n\nWindows 10 ou 11, 64 bits. O link é temporário e pessoal; não compartilhe. Se expirar, fale com o suporte.\n\n1. Baixe e abra o instalador no Windows.\n2. Crie seu administrador no primeiro acesso.\n3. Cadastre produtos, confira preços e estoque e abra o caixa. A emissão fiscal exige configuração e validação próprias.\n\nNão é necessário instalar Node.js ou Git. Faça backup antes de atualizar e mantenha as proteções do Windows ativas.\n\nSuporte: ${values.supportEmail}\nInforme o e-mail utilizado na compra.\n\nOmniPVD — Uma nova perspectiva para o seu negócio.\nEste é um e-mail transacional. Se não reconhece a contratação, contate o suporte.`;
  return {
    subject: 'Bem-vindo ao OmniPVD — seu acesso está disponível',
    html,
    text,
    attachments: [{ filename: 'omnipvd.png', content: logo.toString('base64'), contentId: 'omnipvd-logo' }],
  };
}
