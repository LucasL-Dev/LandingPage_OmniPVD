# Stripe → fila persistente → Resend → download privado

Leia primeiro [DECISIONS.md](DECISIONS.md): a hospedagem e o armazenamento precisam ser confirmados antes de ativar. Nenhuma cobrança ou envio real foi habilitado. A landing page e os parâmetros do Checkout foram preservados.

## Arquitetura e dependências

- Node.js 24: `node:sqlite` (ainda experimental nessa versão), SDKs oficiais `stripe` e `resend`.
- Uma instância contínua do servidor. SQLite com WAL em volume **persistente**, privado, fora do checkout. Não usar disco efêmero/serverless ou múltiplas réplicas com esta implementação.
- Instalador `.exe` real em disco privado fora do checkout, servido pelo backend HTTPS. Não há instalador adicionado ao repositório, URL fictícia ou bucket público.
- Resend: domínio/remetente verificado e API key no servidor. Segredos não pertencem ao Git, navegador ou logs.
- O frontend continua chamando o Checkout existente; apenas rotas de backend e worker foram acrescentados.

O serviço não é um sistema de login. Links são tokens bearer aleatórios de 256 bits; ficam vinculados no banco ao cliente/assinatura, expiram em 48 horas e exigem autorização atual na Stripe a cada uso. Quem possui um link válido pode utilizá-lo enquanto a assinatura estiver autorizada. Para validação da identidade do destinatário, adicionar login/OTP antes de produção. Bloqueie query strings nos logs do proxy e não publique payloads da fila.

## Variáveis

Copie [.env.example](../.env.example) para `.env` local ignorado pelo Git, ou use o painel seguro do provedor.

| Variável | Uso |
| --- | --- |
| `STRIPE_SECRET_KEY` | Chave de teste do servidor; o Checkout existente não foi alterado |
| `STRIPE_PRICE_ID` | Price recorrente esperado, já com padrão configurado |
| `DOMAIN` | Origem do retorno do Checkout; `http://localhost:3000` em teste local |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` do endpoint **ou** da sessão Stripe CLI; não são intercambiáveis |
| `BILLING_DB_PATH` | Arquivo absoluto privado, como `/srv/omnipvd-private/billing.sqlite` |
| `RESEND_API_KEY` | Chave Resend privada |
| `RESEND_FROM` | Remetente de domínio verificado, no formato aceito pelo Resend |
| `SUPPORT_EMAIL` | Endereço real de suporte e reply-to |
| `AUTO_WELCOME_EMAIL_ENABLED` | Padrão `false`; somente `true` ativa o worker de envio |
| `PRIVATE_DOWNLOAD_ENABLED` | Padrão `false`; somente `true` ativa o serviço privado |
| `PRIVATE_INSTALLER_PATH` | Caminho absoluto do instalador real, fora do projeto/public_html |
| `DOWNLOAD_ORIGIN` | Origem HTTPS real da API que atende `/api/download`; sem path/query/credenciais |

No Windows, os caminhos absolutos podem ser `C:\omnipvd-private\billing.sqlite` e `C:\omnipvd-private\OmniPVD-Setup.exe`, fora da pasta do site. O serviço só é inicializado se existirem Stripe e `BILLING_DB_PATH`; senão o Checkout funciona e webhook/download retornam 503. Diretório e banco são criados automaticamente, mas você precisa provisionar volume, backups, permissões, espaço em disco e o instalador real. Configuração inválida do banco impede inicialização e deve ser corrigida.

O banco contém dados comerciais, e-mails e payload com link temporário em texto para manter o mesmo conteúdo nas tentativas. Tokens de autorização são indexados por SHA-256. Proteja banco, WAL, SHM e backups com acesso restrito e criptografia do volume. A aplicação não imprime payload, token, corpo do webhook, chaves ou detalhes do provedor nos logs.

## Webhook e autorização

`POST /api/stripe/webhook` recebe até 1 MiB, valida `Stripe-Signature` com SDK oficial e **Buffer original**, sem parsing JSON anterior. Assinatura inválida responde 400; falta de configuração/falha temporária responde 503 para a Stripe repetir; processamento persistido responde 200. Neste estágio eventos `livemode: true` são rejeitados. Não use endpoint live.

Assine estes eventos no endpoint de **teste**:

- `invoice.paid`: verifica a fatura novamente na Stripe. Só `billing_reason=subscription_create`, com status pago e assinatura atual autorizada para o Price esperado, cria a entrega de boas-vindas. Uma fatura de renovação atualiza o acesso, sem novo e-mail de boas-vindas.
- `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.voided`, `invoice.marked_uncollectible`: consultam a assinatura/fatura atual e bloqueiam autorização quando o pagamento atual não estiver confirmado.
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`: atualizam o estado atual da assinatura. Cancelamento imediato revoga acesso; cancelamento agendado mantém acesso até o período efetivamente pago enquanto a assinatura continuar ativa.

`checkout.session.completed` **não** envia e-mail: o retorno do Checkout e a conclusão da sessão não são prova suficiente de pagamento. Assinaturas em trial, incompletas, pausadas, inadimplentes ou canceladas não recebem acesso. Uma falha antiga não revoga uma renovação já recuperada, porque a fonte de autorização é consultada na Stripe, não o snapshot antigo do evento. Não há período de tolerância para inadimplência nesta implementação.

Cada evento válido tem ID único persistido. Em uma transação, são gravados estado, entrega (única por assinatura) e confirmação do evento. Se o processo cair antes do commit, a Stripe pode repetir. Se cair depois, o ID impede repetição. Eventos não utilizados são apenas registrados. Cada pedido de download também consulta a Stripe; se ela estiver indisponível, o acesso falha fechado com 503.

## Fila, retries e operação

O worker roda a cada 30 segundos, até 20 entregas por ciclo, apenas com flags e configuração completas. Antes de preparar o payload ou enviar, verifica o instalador privado, a origem HTTPS e a assinatura autorizada. Usa `buildWelcomeEmail()` com nome, plano, valor efetivamente pago na primeira fatura, periodicidade do Price, data em `America/Sao_Paulo` e URL real de acesso.

Tabelas SQLite: `events`, `subscriptions`, `deliveries`, `downloads`. `deliveries.status` pode ser `pending`, `sending`, `retry`, `sent` ou `manual_review`. Há lease de cinco minutos para retomada após queda. Jobs não autorizados aguardam recuperação sem enviar. As chamadas ao Resend têm timeout de 30 segundos. Falhas de envio têm backoff exponencial entre 30 segundos e uma hora.

Payload e token são persistidos **antes** da chamada ao Resend. A chave `omnipvd-welcome-<subscription_id>` e o payload são reutilizados em retries e reinícios. Após oito tentativas ou 23 horas desde a primeira chamada, a entrega passa a `manual_review`; não há reenvio automático depois da janela de 24 horas de idempotência do Resend. Um 200 do Resend confirma aceitação, não entrega na caixa postal. Bounces e complaints ainda exigem acompanhamento pelo Dashboard ou webhook Resend futuro.

Para inspecionar: `npm run billing:status`. O comando mostra somente totais e estado dos jobs, sem payload, e-mail ou URL. Não apague linhas/tabelas nem redefina `first_at` para tentar novamente. Para `manual_review`, confira os registros do Resend antes de qualquer ação manual. Se houve aceitação, registre a confirmação de forma auditável; se o envio não aconteceu, planeje uma nova entrega explicitamente autorizada com nova URL. Não há endpoint público de reenvio/reset.

## Testes automatizados — sem e-mails e sem cobranças

```sh
npm ci
npm run check
npm test
```

Os testes criam banco e binário de fixture exclusivos em diretório temporário e usam clientes Stripe/Resend simulados. Verificam: pagamento pendente/recusado, Checkout sem pagamento, duplicação por evento e por fatura, persistência após reinício, renovação sem boas-vindas, falha e recuperação, cancelamento, evento antigo, mesma chave/payload em retry, corte de 23h, flags desligadas, instalador ausente, assinatura real de webhook sobre corpo bruto e adulterado, bloqueio live, download autorizado/cancelado/expirado. Fixtures não são instaladores distribuídos ou links utilizáveis.

## Stripe CLI local e Resend — ativação manual controlada

1. Instale Stripe CLI pela documentação oficial e execute `stripe login` na conta de **teste**.
2. Mantenha `AUTO_WELCOME_EMAIL_ENABLED=false` e `PRIVATE_DOWNLOAD_ENABLED=false`. Configure chave Stripe de teste, banco local persistente fora do checkout e `DOMAIN=http://localhost:3000`.
3. Encaminhe os eventos:

   ```sh
   stripe listen --events invoice.paid,invoice.payment_failed,invoice.payment_action_required,invoice.voided,invoice.marked_uncollectible,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted --forward-to localhost:3000/api/stripe/webhook
   ```

4. Cadastre o `whsec_...` dessa sessão em `STRIPE_WEBHOOK_SECRET`, sem compartilhar o valor, e execute `npm start` (`npm.cmd start` no PowerShell). Reinicie quando alterar variáveis.
5. Abra a página local e conclua uma assinatura de **teste** com o Price configurado e cartão `4242 4242 4242 4242`, validade futura e CVC de teste. Não use cartões reais. Confira eventos 200 na CLI e estado `pending` no banco. Sem flags, nenhum envio ocorre.
6. Use `stripe events resend <event_id> --webhook-endpoint=<endpoint_id>` para repetir para um endpoint de teste cadastrado, ou o recurso Resend do evento no Dashboard. A CLI `listen` encaminha os eventos novos; não confunda o secret dela com o do endpoint cadastrado. A mesma entrega deve continuar única.
7. `stripe trigger invoice.paid` cria fixtures da CLI que podem pertencer a outro Price ou cliente; isso testa transporte, não o fluxo comercial desta assinatura. Para testar recorrência/falhas reais de teste, use Test Clocks e os cenários oficiais Stripe na mesma assinatura, sem acionar cobranças live.
8. Para validar Resend end-to-end deliberadamente, confirme primeiro o instalador real e uma origem HTTPS de staging/túnel que encaminhe a esta API, com logs de query desativados. Configure remetente verificado, suporte e `RESEND_API_KEY` no servidor. Use somente destinatário de teste sob seu controle, respeitando as restrições do domínio de teste Resend.
9. Só então habilite **ambas** as flags e reinicie. Isso enviará e-mails aos jobs elegíveis já pendentes: revise a fila primeiro. Confira no Resend a aceitação e na caixa de teste a logo, HTML/texto e link. O link deve negar token adulterado/expirado e assinatura cancelada. Não habilite flags enquanto o download real não estiver disponível.
10. Desative as flags ao terminar. Não migre para live nesta etapa. Uma nova assinatura de teste possui outro ID e pode gerar outra entrega, como esperado.

Referências: https://docs.stripe.com/cli · https://docs.stripe.com/billing/testing · https://docs.stripe.com/webhooks · https://resend.com/docs/send-with-nodejs · https://resend.com/docs/dashboard/emails/idempotency-keys

## Limitações operacionais

Defina uma política de retenção e exclusão de eventos, dados comerciais, payloads e tokens expirados antes de uso contínuo. Esta etapa não implementa limpeza automática nem monitoração externa; acompanhe fila, falhas, espaço em disco, validade do instalador e backups. Não restaure um backup antigo sem reconciliar os envios já aceitos no Resend, pois isso pode perder o estado de idempotência após a janela do provedor.
