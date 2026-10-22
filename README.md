# Landing page OmniPDV

Página estática responsiva em português, com a identidade verde `#285d53` do [aplicativo oficial](https://github.com/LucasL-Dev/PDV_Sistem), temas claro/escuro, preço de R$ 79,90 e apresentação dos recursos reais.

## Executar

Com Node.js 24, execute `npm start` nesta pasta. Porta padrão: 3000 (configurável com `PORT`). Não há dependências de produção ou build. Verificação: `npm run check`. Os arquivos HTML, CSS, JS e `assets/` também podem ser hospedados como site estático.

## Assinatura e entrega

Todos os CTAs de download levam à seção de assinatura. O fluxo comercial previsto é: assinatura → confirmação do pagamento → acesso ao instalador por e-mail.

Em `app.js`, preencha `config.subscriptionUrl` com a URL HTTPS do checkout oficial. Configure a entrega protegida do instalador na plataforma de pagamento, ou em um backend que valide webhooks de pagamento e envie e-mail. Essa integração ainda não existe neste repositório; a página estática não processa pagamentos nem envia e-mails. Não exponha um instalador pago em assets públicos e não coloque segredos no JavaScript.

O valor é R$ 79,90. A periodicidade não foi informada e não foi presumida; configure-a junto às condições comerciais antes de abrir a contratação. Enquanto o checkout não estiver configurado, o CTA explica que a assinatura está indisponível.

## Marca e captura

O símbolo `assets/omnipdv.png` vem do repositório oficial. `assets/omnipdv-app.png` é uma captura real do Electron executando o código do aplicativo em modo escuro, obtida pelo smoke test oficial em ambiente isolado, com dados de demonstração. Não é uma imagem gerada ou uma recriação da interface. O teste usa dados fictícios, sem informações de clientes reais.

O tema segue a preferência do sistema no primeiro acesso, permite alternância no cabeçalho e salva a escolha no navegador. Cores e escala estão em `styles.css`.
