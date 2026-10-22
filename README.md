# Landing page OmniPDV

Página responsiva em português, sem dependências de produção. Identidade e funcionalidades baseadas em [PDV_Sistem](https://github.com/LucasL-Dev/PDV_Sistem): verde `#285d53`, fundos claros, logotipo oficial, caixa, estoque, clientes, Excel e NFC-e.

## Executar

Com Node.js 24, nesta pasta:

```sh
npm start
```

O servidor escuta na porta 3000, configurável com `PORT`. Execute `npm run check` para verificar a sintaxe. Não é necessário instalar pacotes ou compilar; `index.html`, `styles.css`, `app.js` e `assets/` também podem ser publicados em uma hospedagem estática.

## Download e contratação

Em `app.js`, o objeto `config` centraliza:

- `downloadUrl`: workflow oficial Windows documentado pelo aplicativo. Exige login no GitHub e uma execução com sucesso com artefato ainda disponível. O botão abre o workflow, não baixa automaticamente um executável. Substitua por um instalador oficial ou Release quando disponível.
- `subscriptionUrl`: preencher com o checkout ou canal comercial oficial HTTPS. Enquanto vazio, o botão explica que a contratação ainda não está disponível.
- `priceLabel` e `priceDescription`: preencher com o valor e a periodicidade reais. Sem preço definido, a página mostra “Em breve”.

Revise também as condições e respostas sobre assinatura em `index.html` ao definir a oferta. Nenhum valor, depoimento, avaliação ou resultado comercial foi inventado. A interface do hero é uma ilustração conceitual, com dados explicitamente ilustrativos, não uma captura do software.

As cores estão nas variáveis do início de `styles.css`. O logo em `assets/omnipdv.png` foi copiado dos assets oficiais do repositório informado. O instalador Windows, a disponibilidade dos artefatos e a contratação dependem dos respectivos serviços externos; esta página não processa pagamentos.
