# Landing Page estática — Hostinger compartilhada

Destino comercial: **https://omnipdv.com.br**. A API vive separadamente em **https://api.omnipdv.com.br** na VPS. Este guia contém passos para execução manual futura: nenhum deploy, DNS, compra ou alteração em serviços é efetuado pelo build.

## Gerar o pacote no computador de desenvolvimento

Requer Node.js 24. Na raiz do repositório:

```sh
npm ci
npm run check
npm test
npm run build:landing
npm run zip:landing
```

No PowerShell com bloqueio de scripts, use `npm.cmd` no lugar de `npm`. `build:landing` recria `dist-landing/` por uma lista fechada de arquivos. `zip:landing` reconstrói essa pasta e gera `omnipdv-landing.zip`, com `index.html` diretamente na raiz. Não cria um ZIP do repositório inteiro. O ZIP não depende do utilitário `zip` do sistema.

Os artefatos são gerados e ignorados pelo Git; não há publicação de Release automática. Regere-os sempre que mudar o frontend. Não execute esses comandos sobre o diretório de produção/public_html; execute no checkout de desenvolvimento.

## Lista exata para public_html

```text
public_html/
├── index.html
├── styles.css
├── app.js
├── landing-config.js
└── assets/
    ├── omnipdv.png
    └── omnipdv-app.png
```

São **seis arquivos**. Nenhum outro arquivo do repositório é necessário no site comercial. A logo e a captura real do aplicativo são públicas; nenhum instalador .exe é incluído.

**Não enviar** `.env`, `.env.example`, `.git`, `node_modules`, `package.json`, arquivos de servidor, pastas `auth`, `billing`, `licensing`, `emails`, `db`, testes, SQLite, WAL/SHM, chaves privadas ou instaladores. Nunca usar o ZIP “Download source code” do GitHub como pacote de publicação do site.

## Publicar no Gerenciador de Arquivos

1. Confira no hPanel que selecionou a hospedagem compartilhada do domínio **omnipdv.com.br**, não a VPS/API nem outro site.
2. Faça backup dos arquivos públicos já existentes. Não exclua pastas ou configurações desconhecidas do provedor.
3. Abra o Gerenciador de Arquivos e o `public_html` correspondente ao domínio.
4. Envie somente `omnipdv-landing.zip` e extraia diretamente nesse `public_html`. Não deve surgir um nível extra `dist-landing/` ou uma pasta com o nome do repositório.
5. Confira a árvore de seis arquivos acima. Substitua apenas os arquivos públicos da landing page, preservando arquivos do provedor necessários (como `.well-known` e regras de HTTPS).
6. Retire o ZIP da área pública após extrair. Se houver um `index.php` antigo com prioridade sobre `index.html`, faça backup e ajuste a página inicial conforme a configuração dessa hospedagem. Não apague aplicações desconhecidas.
7. Confirme SSL válido para **omnipdv.com.br**, sem mixed content. Se usar `www`, configure redirecionamento para a origem canônica sem `www` **antes** de servir a landing; o CORS não libera `www`.
8. Limpe o cache do site/CDN se aplicável e faça o teste de navegador abaixo.

## Comunicação com a API

`landing-config.js` é configuração **pública**, contendo somente `apiOrigin=https://api.omnipdv.com.br`. O botão POSTa para `/api/create-checkout-session` nessa origem com JSON, `mode: cors` e `credentials: omit`. Não usa cookies, chaves Stripe, tokens de conta ou Resend. O frontend não confirma pagamentos nem concede downloads pelo parâmetro de retorno.

A API permite CORS exclusivamente para `https://omnipdv.com.br` nessa rota. Não adicionar wildcard, `Access-Control-Allow-Credentials`, proxy público ou permissões de CORS em `.htaccess` como tentativa de corrigir um erro. CORS é configurado no Node da VPS, não no site estático.

O retorno de teste da Stripe é `https://omnipdv.com.br/?checkout=success&session_id=...`. A página avisa que o retorno não confirma a compra. O webhook autenticado na API continua sendo responsável pela confirmação, fila, e-mail e download protegido.

Passkeys, conta e licenças ficam em `https://api.omnipdv.com.br/account/login` e nas rotas `/api/auth/*`, `/api/license/status`, `/api/download` e `/api/stripe/webhook` da VPS. Não copiar essas páginas ou backend para `public_html`.

## Teste manual depois de um deploy autorizado

- Abrir a origem HTTPS canônica e conferir logo, captura, responsividade, menu, tema claro/escuro e FAQ.
- No DevTools → Network, clicar em assinar: devem ocorrer OPTIONS e POST para **api.omnipdv.com.br**, não para o domínio comercial. O preflight deve retornar 204; o POST, 200 com URL do Checkout de teste.
- Verificar que a requisição não inclui Cookie nem Authorization e que o Checkout é de teste. Não concluir compras reais.
- Ao cancelar ou retornar de um pagamento de teste, deve voltar ao site comercial. Não considerar esse retorno como confirmação de cobrança ou envio de e-mail.
- Se houver erro, conferir API/SSL, CORS, variáveis e console antes de mexer no frontend. Um 503 pode significar configuração pendente; não publicar segredos para resolver.

Esses passos manuais não foram executados na Hostinger nesta tarefa. A verificação automatizada usa servidores locais e Stripe/Resend simulados.

## Preview local separado

Para testar sem depender da VPS, use dois processos e configure o CORS com uma única origem local explícita:

- Backend: `SITE_ORIGIN=http://localhost:4173`, `API_ORIGIN=http://localhost:3000`, `HOST=127.0.0.1`, `PORT=3000`; execute `npm start` com chave Stripe **de teste** quando for testar o provedor.
- Frontend: configure **somente no terminal do build** `LANDING_API_ORIGIN=http://localhost:3000`, execute `npm run build:landing` e `npm run preview:landing`. Esse preview serve somente os seis arquivos e nenhuma API. Não carrega `.env`.
- No PowerShell: `$env:LANDING_API_ORIGIN='http://localhost:3000'`. No shell Unix: `LANDING_API_ORIGIN=http://localhost:3000 npm run build:landing`.
- Antes de gerar o pacote para a Hostinger, remova a variável local (`Remove-Item Env:LANDING_API_ORIGIN` no PowerShell ou `unset LANDING_API_ORIGIN` no shell Unix) e execute `npm run zip:landing` novamente. O padrão do pacote volta a `https://api.omnipdv.com.br`.

`LANDING_API_ORIGIN` aceita apenas origem HTTPS ou HTTP de loopback explícito. Não injeta o restante do ambiente, não lê `.env` e nunca deve conter credenciais. A origem da API não é segredo.
