# Landing page OmniPDV

Página estática responsiva em português, com a identidade verde `#285d53` do [aplicativo oficial](https://github.com/LucasL-Dev/PDV_Sistem), temas claro/escuro, preço de R$ 79,90 e apresentação dos recursos reais.

## Executar e configurar pagamentos

Com Node.js 24, execute `npm ci` e `npm start`. A porta padrão é 3000 (`PORT` permite alterar). O checkout requer o servidor Node; hospedagem somente estática não executa a API.

Consulte [STRIPE_INTEGRATION_TODO.md](STRIPE_INTEGRATION_TODO.md) para todas as configurações, pendências, testes e instruções de pagamento e entrega por e-mail.

Todos os CTAs de download levam à assinatura de R$ 79,90. O CTA de assinatura usa Stripe Checkout. O webhook de teste, a fila SQLite, o envio via Resend e o serviço de download privado estão implementados. O envio automático fica desligado até configurar infraestrutura e flags; consulte [billing/README.md](billing/README.md).

## Marca e captura

O símbolo `assets/omnipdv.png` vem do repositório oficial. `assets/omnipdv-app.png` é uma captura real do Electron executando o código do aplicativo em modo escuro, obtida pelo smoke test oficial em ambiente isolado, com dados de demonstração. Não é uma imagem gerada ou uma recriação da interface. O teste usa dados fictícios, sem informações de clientes reais.

O tema segue a preferência do sistema no primeiro acesso, permite alternância no cabeçalho e salva a escolha no navegador. Cores e escala estão em `styles.css`.

## E-mail de boas-vindas

O template responsivo e o renderer para preparar o payload do Resend estão em [emails/README.md](emails/README.md). Incluem logo inline, dados dinâmicos, versão texto e URL de download fornecida pelo backend. Nenhum envio foi habilitado por padrão.

## Webhook, persistência e download privado

Antes de ativar qualquer envio, leia [as decisões de infraestrutura](billing/DECISIONS.md) e o [guia de configuração, operação e testes com Stripe CLI/Resend](billing/README.md). Requer Node.js 24, volume persistente privado e uma única instância. O instalador não está no repositório.

## Fase A — autenticação e licenciamento

Login por passkey no navegador, autorização desktop com PKCE, sessões revogáveis e licença offline Ed25519 estão disponíveis de forma opt-in (`AUTH_ENABLED=false` por padrão). Leia [licensing/README.md](licensing/README.md) para arquitetura, vinculação verificada ao cliente Stripe, variáveis, migrações, protocolo do aplicativo e testes. O executável Windows não é alterado por este repositório.

## VPS Ubuntu 24.04 + Node.js 24

O [guia de implantação](docs/DEPLOY-UBUNTU.md) contém os comandos completos, variáveis, systemd, Caddy HTTPS, diretórios privados, backups consistentes, atualização/rollback/restauração e rotação Ed25519. A hospedagem pode ser de produção, mas esta entrega **continua restrita à Stripe de teste**. Nenhuma VPS ou cobrança real é configurada automaticamente. Use `ops/backend.env.example` como referência privada; não versione o ambiente preenchido.
