# Integração Stripe — configuração pendente

Fonte única dos passos restantes. Cenário B: não existia criação de Checkout Session. Foi adicionado `POST /api/create-checkout-session` ao servidor Node existente e o botão de assinatura passou a chamar essa rota.

## Valores a substituir

**Arquivos com configurações de exemplo:** [.env.example](.env.example), [server.mjs](server.mjs).

| Campo | Valor atual | O que definir |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_...` no exemplo; ausente no ambiente | Chave secreta de teste nas variáveis do servidor. Nunca no frontend, Git ou chat. |
| `line_items[].price` / `STRIPE_PRICE_ID` | `price_1UVCotRyOKs2Cpl0wvQXsmAi` (configurado como padrão) | ID informado já configurado. Verificar na Stripe se é recorrente, em BRL, R$ 79,90, e do mesmo modo da chave. `STRIPE_PRICE_ID` permite substituir o padrão. |
| `mode` | `subscription` | Mantido para assinatura recorrente. Confirmar a periodicidade comercial no Price; ela ainda não foi informada. |
| `success_url` | `${DOMAIN}/?checkout=success&session_id={CHECKOUT_SESSION_ID}` | Hostinger já configurada como padrão; `DOMAIN` permite substituir a origem. Manter o template `{CHECKOUT_SESSION_ID}`. A página de retorno não confirma pagamento. |
| `cancel_url` | `${DOMAIN}/?checkout=cancelled#assinatura` | Hostinger já configurada como padrão; `DOMAIN` permite substituir a origem. |
| `DOMAIN` | `https://mediumslateblue-falcon-614408.hostingersite.com` (padrão configurado) | Origem pública HTTPS de produção; HTTP local apenas no desenvolvimento. |

## Parâmetros configurados

**Arquivo:** [server.mjs](server.mjs).

| Parâmetro | Valor |
| --- | --- |
| `ui_mode` | `hosted_page` |
| `billing_address_collection` | `auto` |
| `phone_number_collection` | `{ enabled: false }` |
| `automatic_tax` | `{ enabled: false }` |
| `allow_promotion_codes` | `false` |
| `payment_method_collection` | `always` (modo subscription) |
| `submit_type` | `auto` |
| `integration_identifier` | `hosted_web_0001` |
| `origin_context` | `web` |

SDK instalado: `stripe@23.0.1`, compatível com `hosted_page` (SDKs anteriores a 21 usam `hosted`). A inicialização não fixa uma versão da API.

## Instalação e execução

1. Node.js 24: execute `npm ci`.
2. Configure as variáveis do servidor no provedor de hospedagem. Para desenvolvimento, copie `.env.example` para `.env`, substitua os valores e execute `npm start`. O servidor carrega `.env` automaticamente se existir; variáveis já exportadas têm precedência.
3. Execute `npm run check` e `npm test`.
4. Use uma hospedagem que execute Node.js. Hospedagem apenas estática, como GitHub Pages, não executa a rota de checkout. O servidor permite somente arquivos públicos e não serve `.env`, Git ou código de backend.

Não é necessária chave publicável para este fluxo hospedado. O Checkout não cria contas de usuário. Quando configurado, o módulo de billing persiste IDs, autorização e fila em SQLite privado; veja billing/README.md.

## Fluxo e validação

O CTA chama o endpoint → servidor cria Checkout Session com o Price definido no servidor → navegador abre `checkout.stripe.com` → Stripe devolve à landing page. Falhas de configuração e de rede são mostradas ao usuário, sem expor detalhes privados da Stripe.

Os testes automatizados usam um cliente Stripe simulado: verificam parâmetros, resposta, erros, origem e proteção de arquivos. **Nenhuma sessão real ou cobrança foi criada**, pois a chave ainda precisa ser cadastrada nas variáveis seguras do servidor. O Price ID informado foi configurado. Validar no modo teste da Stripe antes de produção:

- Cartão aprovado: `4242 4242 4242 4242`, validade futura e CVC de teste.
- Autenticação: `4000 0025 0000 3155`.
- Recusa: `4000 0000 0000 9995`.
- Testar cancelamento, retorno, erro de rede e confirmação no Dashboard.
- Nunca usar cartões reais no modo teste. Ao ativar produção, trocar chave e Price para os recursos live correspondentes.

## Entrega por e-mail e download privado

O webhook Stripe com validação do corpo original, a persistência SQLite, a fila idempotente Resend e o serviço de download privado agora estão implementados. **O envio automático continua desativado por padrão.**

As pendências de infraestrutura, variáveis, operação e testes estão em [billing/README.md](billing/README.md), com decisões prévias em [billing/DECISIONS.md](billing/DECISIONS.md). Antes de ativar: provisionar disco persistente e instalador privado real, configurar origem HTTPS, Resend e webhook de teste, validar end-to-end. O backend desta etapa rejeita eventos live; não habilita cobranças reais. Confirmar periodicidade e condições comerciais antes de qualquer migração live.

## Hospedagem Hostinger

Origem configurada: `https://mediumslateblue-falcon-614408.hostingersite.com`.

- Em uma aplicação **Node.js** no hPanel, conecte o repositório, use instalação `npm ci`, início `npm start` e Node.js 24. Cadastre `STRIPE_SECRET_KEY` no painel seguro da aplicação e reinicie/republique. O código já contém o Price ID e a origem informados; variáveis `STRIPE_PRICE_ID` e `DOMAIN` permitem substituí-los.
- Se o plano/site estiver servindo somente arquivos estáticos, subir os arquivos não executará `server.mjs`. Será necessário usar hospedagem Node.js compatível ou hospedar a API separadamente; não colocar a chave em `app.js`.
- Para teste local, use `DOMAIN=http://localhost:3000` no `.env` ignorado pelo Git.
- A chave compartilhada no chat é de teste. Substitua-a no Dashboard e cadastre a nova no painel seguro. Não a envie por chat ou Git.
- A verificação externa da hospedagem foi bloqueada pelo proxy desta sessão (HTTP 403 no túnel); ainda não foi confirmado que a Hostinger esteja executando a rota Node.js.
