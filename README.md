# Landing page OmniPDV

Página estática responsiva em português, com a identidade verde `#285d53` do [aplicativo oficial](https://github.com/LucasL-Dev/PDV_Sistem), temas claro/escuro, preço de R$ 79,90 e apresentação dos recursos reais.

## Executar e configurar pagamentos

Com Node.js 24, execute `npm ci` e `npm start`. A porta padrão é 3000 (`PORT` permite alterar). O checkout requer o servidor Node; hospedagem somente estática não executa a API.

Consulte [STRIPE_INTEGRATION_TODO.md](STRIPE_INTEGRATION_TODO.md) para todas as configurações, pendências, testes e instruções de pagamento e entrega por e-mail.

Todos os CTAs de download levam à assinatura de R$ 79,90. O CTA de assinatura usa Stripe Checkout. A criação de sessão está implementada; confirmação de pagamento e envio de acesso por e-mail ainda precisam de integração.

## Marca e captura

O símbolo `assets/omnipdv.png` vem do repositório oficial. `assets/omnipdv-app.png` é uma captura real do Electron executando o código do aplicativo em modo escuro, obtida pelo smoke test oficial em ambiente isolado, com dados de demonstração. Não é uma imagem gerada ou uma recriação da interface. O teste usa dados fictícios, sem informações de clientes reais.

O tema segue a preferência do sistema no primeiro acesso, permite alternância no cabeçalho e salva a escolha no navegador. Cores e escala estão em `styles.css`.
