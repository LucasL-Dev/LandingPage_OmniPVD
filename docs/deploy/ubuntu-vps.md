# Backend OmniPDV — Ubuntu 24.04 / Node.js 24 / VPS Hostinger

Arquitetura: **omnipdv.com.br** é estático na hospedagem compartilhada; **api.omnipdv.com.br** é Node.js nesta VPS. Este documento prepara um deploy **manual e futuro**. Nenhum comando foi executado na VPS, no DNS ou nas contas Stripe/Resend nesta tarefa.

## Preservar a instalação existente

Antes de qualquer alteração, registre os caminhos e o serviço atualmente utilizados. Faça backup SQLite consistente com a aplicação/SQLite (não copiar apenas `.sqlite` ignorando WAL enquanto há escrita), chave de licença, instalador e configuração segura. Nunca apague, reinicialize ou substitua o banco por um vazio. Não altere `BILLING_DB_PATH`, remetente, flags de envio ou chave de licença só para seguir um exemplo de caminho.

Use a branch revisada e aprovada para a publicação; não fazer merge automático na main. A branch de separação parte da versão com licenciamento; se esse commit ainda não estiver na main, revisar também essa dependência antes de promover o código. O guia não requer migrações novas: tabelas e entregas permanecem as existentes; as migrações aditivas de licenciamento continuam opt-in.

Confira o ambiente de release, sem exibir segredos:

```sh
node --version
npm ci
npm run check
npm test
```

Node deve ser 24. A suíte usa bancos temporários e Stripe/Resend simulados; não realiza compras ou envios. `npm ci` completo inclui a pequena dependência de build/teste de ZIP; para runtime sem testes pode usar instalação de produção separada, mas não executar testes do build estático sem as devDependencies.

## Origens e variáveis do backend

No arquivo seguro do serviço ou no painel de variáveis da VPS, mantendo as outras configurações existentes:

```dotenv
SITE_ORIGIN=https://omnipdv.com.br
API_ORIGIN=https://api.omnipdv.com.br
AUTH_ORIGIN=https://api.omnipdv.com.br
AUTH_RP_ID=api.omnipdv.com.br
DOWNLOAD_ORIGIN=https://api.omnipdv.com.br
AUTH_ALLOW_LOCALHOST=false
HOST=127.0.0.1
PORT=3000
```

- `SITE_ORIGIN`: origem única permitida no CORS de Checkout e destino dos retornos Stripe. Exige URL de origem sem barra final.
- `API_ORIGIN`: origem pública do backend; usada como padrão da autenticação se `AUTH_ORIGIN` estiver ausente.
- `AUTH_ORIGIN` e `AUTH_RP_ID`: login, cookies, WebAuthn e emissor das licenças. **Antes de mudar, ler a seção de migração de passkeys abaixo.**
- `DOWNLOAD_ORIGIN`: origem HTTPS real que atende o download privado. Continuar exigindo configuração explícita, arquivo privado real e flags anteriores.
- `DOMAIN`: alias legado para o site comercial, somente quando `SITE_ORIGIN` não estiver definido. Não é origem da API e não deve apontar para `api.omnipdv.com.br`. Preferir `SITE_ORIGIN`; não há necessidade de mantê-lo.
- `HOST`/`PORT`: processo local atrás do proxy. O padrão agora é `127.0.0.1:3000`, não uma porta pública.

Preservar `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `RESEND_FROM`, `SUPPORT_EMAIL`, `BILLING_DB_PATH`, `PRIVATE_INSTALLER_PATH`, `LICENSE_PRIVATE_KEY_PATH`, `LICENSE_SIGNING_KEY_ID` e TTLs já configurados. Não incluir seus valores em repositório, comandos compartilhados, frontend ou ZIP.

Somente chaves Stripe `sk_test_`/`rk_test_` são aceitas pelo runtime e pela ferramenta administrativa nesta etapa. Chaves live impedem a inicialização; eventos live continuam bloqueados. Não criar produtos/cobranças live nem mudar o código para contornar esse bloqueio.

As flags `AUTO_WELCOME_EMAIL_ENABLED`, `PRIVATE_DOWNLOAD_ENABLED` e `AUTH_ENABLED` **não são alteradas pelo deploy**. O `.env.example` mantém flags desligadas como padrão seguro; não copiar esse arquivo por cima de um `.env` existente que já tenha sido validado.

## Serviço Node

O processo deve rodar como usuário dedicado sem root, com leitura do código/dependências/instalador/chave e escrita somente no diretório privado de dados. Não utilizar `public_html` para banco ou `.exe`. Código e dados privados têm ciclos de vida diferentes.

Exemplo de unidade systemd a adaptar aos caminhos e usuário **já existentes** (não instalar automaticamente):

```ini
[Unit]
Description=OmniPDV API
After=network.target

[Service]
Type=simple
User=omnipdv
Group=omnipdv
WorkingDirectory=/opt/omnipdv/app
Environment=NODE_ENV=production
EnvironmentFile=/etc/omnipdv/backend.env
ExecStart=/usr/bin/node /opt/omnipdv/app/server.mjs
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/omnipdv

[Install]
WantedBy=multi-user.target
```

Substituir `/var/lib/omnipdv` pelo diretório persistente real do SQLite e seus WAL/SHM. Ajustar `ReadWritePaths` sem mover/apagar o banco. Caminhos privados existentes em `/home` exigem adaptar `ProtectHome` ou planejar migração controlada com backup antes de ativar; não quebrar acessos ao copiar este exemplo. `PrivateTmp` reforça que dados não podem morar em `/tmp`. Verifique o caminho real de Node.js (uma instalação de usuário/nvm não implica `/usr/bin/node`).

Após revisão e em janela autorizada, o operador poderá recarregar/reiniciar o serviço já identificado. Este guia não executa `systemctl`, provisionamento, permissões, DNS ou firewall por conta própria.

## Proxy HTTPS em api.omnipdv.com.br

O operador precisa configurar manualmente DNS/SSL da API. O registro de **api** deve chegar à VPS, e o domínio raiz deve continuar na hospedagem compartilhada. Não alterar registros do domínio comercial para a VPS nesta arquitetura.

Modelo de proxy Nginx a adaptar após obter certificado válido (não é arquivo instalado automaticamente):

```nginx
# Definir no contexto http{}, nunca dentro do bloco server{}:
log_format omnipdv_private '$remote_addr $request_method $uri $status';

server {
    listen 443 ssl;
    server_name api.omnipdv.com.br;
    ssl_certificate /CAMINHO/DO/CERTIFICADO/fullchain.pem;
    ssl_certificate_key /CAMINHO/DO/CERTIFICADO/privkey.pem;
    access_log /var/log/nginx/omnipdv-access.log omnipdv_private;
    client_max_body_size 1m;

    location = /api/download {
        # Tokens estão na query; impedir gravação no access/error log desta rota.
        access_log off;
        error_log /dev/null;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;
    }
}
```

Não adicionar cabeçalhos CORS no Nginx. O Node controla a política somente na rota de Checkout; duplicar esses cabeçalhos pode quebrar o navegador. Não registrar corpos, Authorization, cookies, convites, chaves ou URLs de download. A supressão de logs do download reduz a observabilidade dessa rota; use métricas/erros genéricos da aplicação sem tokens. Não habilitar debug que exponha requests privados.

O rate limiter de autenticação atual usa IP do socket e não confia em `X-Forwarded-For`. Atrás do Nginx, os clientes compartilham o bucket do proxy. Manter a política conservadora e dimensionar/planejar uma futura configuração explícita de proxy confiável antes de aumentar carga; não liberar cabeçalhos arbitrários para contornar limites.

## Rotas exclusivamente na API

- `/api/create-checkout-session`: único endpoint CORS para `https://omnipdv.com.br`, POST e preflight de Content-Type. Sem cookies ou Authorization da landing.
- `/api/stripe/webhook`: corpo original e assinatura; sem CORS. URL de teste a cadastrar manualmente no Stripe: `https://api.omnipdv.com.br/api/stripe/webhook`.
- `/account/login`, `/account/assets/*`, `/api/auth/*`, `/api/account/claim`: login de navegador e autenticação; mesma origem da API, sem CORS para a landing.
- `/api/license/status`: Bearer do desktop, sem CORS de navegador comercial.
- `/.well-known/omnipvd-license-keys.json`: chaves públicas da licença; sem segredos e sem CORS comercial.
- `/api/download`: token privado e checagem da assinatura; navegação/download direto, não fetch da landing.
- `/health`: liveness simples, não prova configuração do Stripe/Resend, banco ou prontidão comercial.

A raiz e `/index.html` da API redirecionam para o site comercial. `/app.js`, `/styles.css` e a captura da landing não são mais servidos pela API. Somente a logo pública é mantida para a página de conta. Nenhum arquivo arbitrário do repositório é servido.

## Retorno Stripe e teste manual futuro

Os retornos sempre usam `SITE_ORIGIN`, nunca `API_ORIGIN`/`AUTH_ORIGIN`:

- sucesso: `https://omnipdv.com.br/?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
- cancelamento: `https://omnipdv.com.br/?checkout=cancelled#assinatura`.

O parâmetro de retorno não confirma pagamento nem autoriza download. Somente os webhooks verificados e a consulta Stripe de teste alimentam billing/licença. Ao cadastrar o endpoint novo no Dashboard de teste, usar o secret daquele endpoint; não reutilizar sem conferir o secret de outro endpoint/Stripe CLI. Migrar eventos sem duplicar envios é responsabilidade da persistência existente e de uma transição operacional planejada — não remover a tabela de eventos/entregas.

Depois de um deploy autorizado: verificar SSL, `/health`, OPTIONS/POST do Checkout no navegador comercial, rejeição de origem não autorizada, login/passkeys e license-status no cliente de desenvolvimento. Use cartão de teste, não real. O Resend pode enviar mensagens reais a destinatários caso suas flags existentes estejam ligadas; revisar a fila e o ambiente antes de um teste manual de compra. Os testes automatizados desta tarefa não fazem isso.

## Migração de passkeys, sessões e licenças: atenção antes do corte

Passkeys são vinculadas ao RP ID original. Uma credencial criada para um domínio Hostinger antigo ou para `omnipdv.com.br` não passa a pertencer automaticamente a `api.omnipdv.com.br`. A implementação mantém a origem/RP ID configurados e não reescreve credenciais ou vínculos.

- Se ainda há somente contas de teste e nenhuma credencial a preservar, configurar a nova origem antes do cadastro e emitir convites verificados para os clientes ainda não vinculados.
- Se já existem contas/passkeys em outro RP ID, **não trocar o RP ID sem um plano de transição**. A fase A não tem recuperação automática de contas vinculadas nem convite de recuperação para cliente já vinculado. Manter a origem anterior funcional até definir um procedimento auditado de recadastro/migração; não apagar contas, credenciais ou banco para resolver.
- Alterar `AUTH_ORIGIN` muda também o issuer de novas licenças. O desktop deve apontar para a nova API e confiar no issuer/chaves públicas corretos. Preservar a chave privada e `kid`; não gerar nova chave como parte deste deploy. Licenças anteriores continuam verificáveis pelo prazo assinado com a confiança anterior; planejar a transição sem ampliar validade.
- Sessões browser são host-only e não migram entre hosts. O usuário precisará entrar na nova origem. Tokens desktop persistem no banco, mas o cliente precisa usar o novo endpoint e a política de issuer apropriada.

Nenhuma dessas mudanças foi aplicada automaticamente nesta tarefa.
