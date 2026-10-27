# E-mail de boas-vindas OmniPVD

- [boas-vindas.html](boas-vindas.html): template com tabelas, estilos inline, preheader, layout de até 600 px, ajuste móvel e botão VML para Outlook clássico.
- [render-welcome.mjs](render-welcome.mjs): prepara `subject`, `html`, `text` e o anexo inline da logo oficial, no formato do SDK Node do Resend. Não envia e-mails, não usa chaves e não faz chamadas de rede.

## Dados obrigatórios

| Campo | Conteúdo |
| --- | --- |
| `customerName` | Nome do cliente confirmado no backend |
| `planName` | Nome do plano comprado |
| `price` | Valor já formatado, por exemplo `R$ 79,90` |
| `billingPeriod` | Periodicidade real do Price da Stripe, como `mês` ou `ano` |
| `purchaseDate` | Data formatada conforme o fuso comercial, preferencialmente `America/Sao_Paulo` |
| `downloadUrl` | URL HTTPS temporária e assinada, gerada pelo backend |
| `supportEmail` | Endereço real de atendimento |

Não existe link de download padrão. O HTML contém `{{downloadUrl}}` no botão comum e no botão Outlook; o renderer exige o valor e faz escape de todos os dados. Os parâmetros da URL assinada são preservados. Não envie o HTML bruto com placeholders.

A logo oficial é carregada de `assets/omnipdv.png` e incorporada por CID (`omnipvd-logo`), sem dependência de hospedagem externa. Não remova `attachments` ao passar o payload ao Resend. Clientes que bloqueiam imagens continuam exibindo o nome da marca em texto.

## Integração futura com Resend

Depois de validar o pagamento no backend e gerar o acesso seguro:

```js
import { buildWelcomeEmail } from './emails/render-welcome.mjs';

const email = await buildWelcomeEmail({
  customerName: customer.name,
  planName: order.planName,
  price: order.formattedPrice,
  billingPeriod: order.formattedBillingPeriod,
  purchaseDate: order.formattedPurchaseDate,
  downloadUrl: signedDownloadUrl,
  supportEmail: process.env.SUPPORT_EMAIL,
});

// Na integração futura: passar o payload ao cliente Resend configurado no servidor.
// const result = await resend.emails.send({
//   from: process.env.RESEND_FROM, // Remetente de domínio verificado no Resend.
//   to: customer.email,
//   replyTo: process.env.SUPPORT_EMAIL,
//   ...email,
// });
// Verificar result.error e persistir o envio para evitar duplicações.
```

`RESEND_API_KEY` deve ficar exclusivamente nas variáveis seguras do servidor. Não há SDK Resend instalado nem envio habilitado nesta etapa. O backend futuro deve validar a assinatura dos webhooks Stripe, verificar o pagamento, autorizar o cliente e emitir links com validade e controle de acesso. Validar HTTPS no renderer não verifica assinatura, autorização ou expiração: essas garantias pertencem ao serviço de download.

Não grave URLs assinadas em logs públicos. Configure a política de rastreamento de links do provedor de acordo com os requisitos do serviço de download. Envie somente após confirmação efetiva do pagamento, com idempotência por pedido/evento; não use o retorno do navegador como prova de compra.

## Verificação

Execute `node --test tests/email.test.mjs`. Os testes renderizam em memória com URL de teste explicitamente não funcional e verificam escape, validação e logo inline. Nenhum e-mail é enviado. O HTML pode ser aberto localmente para conferir a estrutura, mas a logo CID só aparece quando incorporada ao e-mail ou substituída num preview local. Compatibilidade visual final deve ser validada em Gmail, Outlook e Apple Mail; os testes não simulam todos os clientes.
