# OmniPDV — site comercial e API separados

- **https://omnipdv.com.br**: Landing Page estática na hospedagem compartilhada Hostinger, com design verde, temas claro/escuro e captura real do aplicativo.
- **https://api.omnipdv.com.br**: backend Node.js 24 na VPS, com Stripe de teste, Resend, SQLite persistente, autenticação/passkeys, licenciamento e download privado.

## Gerar a Landing Page

```sh
npm ci
npm run build:landing
npm run zip:landing
```

`dist-landing/` contém somente `index.html`, `styles.css`, `app.js`, `landing-config.js`, `assets/omnipdv.png` e `assets/omnipdv-app.png`. `omnipdv-landing.zip` inclui esses seis arquivos sem uma pasta adicional na raiz. Ambos são gerados e ignorados pelo Git; não publicar o ZIP do código-fonte inteiro.

[Guia de publicação no Gerenciador de Arquivos Hostinger](docs/deploy/hostinger-static.md).

## Backend e testes

```sh
npm run check
npm test
npm start
```

O backend escuta em `127.0.0.1:3000` por padrão (`HOST`/`PORT` permitem alterar). A raiz redireciona ao site comercial. Para preview do site separado: `npm run preview:landing`, após gerar o build. Configuração local entre os dois processos está no guia estático.

[Guia Ubuntu 24.04 / Node.js 24 / VPS](docs/deploy/ubuntu-vps.md). Nenhuma infraestrutura é alterada pelos scripts de build ou testes.

`SITE_ORIGIN` controla retorno Stripe e CORS estrito de Checkout; `API_ORIGIN` identifica o backend; `AUTH_ORIGIN`/`AUTH_RP_ID` controlam passkeys e issuer; `DOWNLOAD_ORIGIN` identifica o download privado. Cookies e tokens de autenticação não são usados pela landing estática. Somente o webhook verificado confirma pagamento, nunca o retorno do navegador.

## Componentes

- [Stripe e configurações pendentes](STRIPE_INTEGRATION_TODO.md).
- [Billing, fila Resend e download privado](billing/README.md), com [decisões de persistência](billing/DECISIONS.md).
- [Template de e-mail](emails/README.md), preparado no backend com logo incorporada e URL privada real.
- [Contas, passkeys e licenciamento](licensing/README.md). O aplicativo Windows deve integrar esse protocolo; este repositório não altera o executável.

As flags de envio, download e autenticação permanecem desligadas por padrão no exemplo. Não substituir configurações já validadas pelo `.env.example`. Não publicar segredos, bancos, chaves ou instaladores e não fazer merge/deploy automaticamente. O runtime rejeita chaves Stripe live nesta etapa.

## Marca

Identidade verde `#285d53` e logo de [PDV_Sistem](https://github.com/LucasL-Dev/PDV_Sistem). `assets/omnipdv-app.png` é captura real do aplicativo com dados fictícios. Nenhuma informação de cliente real está no pacote estático.
