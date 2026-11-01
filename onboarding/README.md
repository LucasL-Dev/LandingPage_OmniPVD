# Cadastro automático pós-compra — OmniPDV

Base: `feat/production-integration`. O Checkout, o formato de licença, as chaves Ed25519 e o projeto Electron não são modificados. O recurso é opt-in, exclusivamente Stripe Sandbox. Nenhum deploy, e-mail real, cobrança ou alteração na VPS faz parte desta implementação.

## Funcionamento

1. O webhook continua exigindo assinatura Stripe sobre o corpo original. `invoice.paid` é conferido por consulta à Stripe; somente fatura inicial `subscription_create` efetivamente paga e assinatura autorizada entram na entrega de boas-vindas.
2. Ao preparar uma **nova** mensagem na fila existente, o backend confirma os IDs de cliente/assinatura e congela `customer_email` da fatura paga. Não usa o e-mail enviado pelo navegador nem um contato Stripe alterado posteriormente como destino de ativação.
3. Para cliente ainda não vinculado, cria um convite de 256 bits, válido por 48 horas. O e-mail existente recebe o link do instalador privado e instruções/link de ativação na origem da API. Para cliente já vinculado, recebe acesso ao login existente, sem nova conta ou convite.
4. O convite abre `/account/login#invite=...` em `https://api.omnipdv.com.br`. O fragmento é removido do histórico pela página e não é enviado como query ao servidor. O convite sozinho **não** permite cadastrar uma passkey.
5. O comprador solicita um código novo de 8 dígitos. A fila envia o código somente ao endereço congelado da compra. O código vale 10 minutos, tem no máximo cinco tentativas e fica associado à solicitação e ao convite exatos.
6. A confirmação retorna uma prova aleatória de 256 bits, com validade de 10 minutos. A página mantém essa prova apenas em memória. Recarregar a página exige verificar novamente; não há token em localStorage/sessionStorage.
7. Cadastro WebAuthn exige convite + prova do e-mail + desafio de passkey válido. Conta, credencial, vínculo ao cliente Stripe e consumo do convite/prova são gravados na mesma transação. Há confirmação criptográfica da passkey, RP ID/origin exatos e verificação do usuário.
8. O desktop continua usando login externo, consentimento, PKCE e Bearer já implementados. Depois do login, `/api/license/status` verifica automaticamente a assinatura da conta autenticada e emite a mesma licença assinada de antes. O backend não entrega uma licença apenas por possuir convite, e-mail, `session_id` de retorno Stripe ou token de download.

O cadastro da conta OmniPDV na API é diferente do administrador local da loja no aplicativo. A página explica ambos os passos; o binário Electron não foi alterado nesta branch.

## Identidade e prevenção de apropriação

- Não há vínculo automático por igualdade de e-mail. O cliente Stripe provém da fatura inicial conferida no servidor; o navegador não escolhe um `customer_id`/assinatura.
- O vínculo único existente em `auth_stripe_links` continua sendo a autoridade. Um cliente já vinculado não pode receber outra conta por este fluxo.
- E-mails comprovados nesta automação são indexados por HMAC do endereço normalizado (trim/lowercase), com uma conta por endereço comprovado. Outra compra com esse e-mail exige login na conta existente **e** prova do e-mail antes de vincular outro cliente Stripe. Nunca se associa a compra à conta apenas por saber o endereço.
- Contas legadas não são mescladas ou reatribuídas por e-mail. Não se infere retroativamente a identidade de usuários antigos por contatos Stripe. Aliases distintos de provedores de e-mail também não são fundidos automaticamente.
- Se o endereço da fatura estiver ausente ou divergir do congelado para o mesmo cliente, a automação falha fechada e exige suporte. Não troca o destino para um endereço fornecido pelo solicitante.
- Convites administrativos continuam em `auth_claims`, com o procedimento de suporte já existente. Convites automáticos ficam **fora** dessa tabela: versões antigas não podem aceitá-los como se fossem comprovação administrativa.
- Conta já criada não tem passkeys redefinidas por recuperação de convite. Recuperação de uma conta com todas as passkeys perdidas continua sendo um procedimento de suporte separado.

Esta comprovação verifica acesso atual à caixa postal, não identidade civil. Comprometimento da caixa postal antes do primeiro cadastro é um risco de identidade que requer proteção do próprio e-mail. Depois do cadastro, acesso ao e-mail sozinho não substitui a passkey nem permite assumir uma conta existente.

## Recuperação segura de convite

Na página de ativação, “Meu convite expirou ou não chegou”:

1. O usuário informa o e-mail da compra. O endpoint retorna sempre `ok` e um ID opaco, sem revelar destinatário, cliente, assinatura, existência de compra ou existência de conta.
2. Somente uma compra registrada pela automação e ainda não vinculada recebe código, sempre no endereço original armazenado, nunca num destino alternativo do pedido. Endereço desconhecido ou cliente já vinculado recebe o mesmo formato de resposta, sem envio.
3. Após código válido e nova conferência da compra na Stripe, os convites anteriores são invalidados. O backend cria um convite novo e prova de e-mail; a página pode continuar o cadastro, e uma nova mensagem de ativação também é enfileirada para o e-mail verificado.
4. Se a assinatura ainda estiver autorizada, essa mensagem contém um **novo** link privado real do instalador, válido por 48 horas. Se não estiver, não inclui link fictício nem concede acesso. A conta pode ser identificada, mas a licença continua seguindo o estado da assinatura.
5. Repetir a confirmação de um código já consumido não gera outro convite ou e-mail. Convite usado/expirado não é reativado.

Há limite adicional de 10 requisições de onboarding/minuto por IP de socket, além do limite global de autenticação. Cada endereço permite três solicitações/hora para ativação e três/hora para recuperação. Os limites de e-mail usam HMAC, não e-mail em texto. O comportamento de proxy continua o existente: não confiar cegamente em X-Forwarded-For; atrás do Caddy o bucket de IP é conservador e compartilhado. Respostas 429 têm Retry-After.

Um código pode ser consumido antes de uma conferência Stripe que falhe temporariamente. Nesse caso nenhum vínculo ou novo convite é criado; será necessária nova solicitação de código quando o serviço estiver disponível. Isso falha fechado, sem usar um snapshot de pagamento duvidoso como autorização.

## Fila, criptografia e idempotência

A automação usa o mesmo worker serializado do billing, sem segundo processo ou timer independente. O worker continua sendo drenado no SIGTERM antes de fechar SQLite. E-mails de código e recuperação usam `onboarding_outbox`; boas-vindas continuam em `deliveries`, com a chave Resend existente por assinatura.

- Tokens de validação são armazenados como hashes. O código de 8 dígitos usa HMAC com segredo do servidor para impedir brute force offline de seu pequeno espaço de busca a partir de um vazamento isolado do banco.
- O conteúdo necessário a retries (incluindo URL do convite/código) é retido **cifrado com AES-256-GCM**, com nonce aleatório e AAD vinculada ao tipo/ID do registro. Não há cópia desses tokens em texto aberto nas novas colunas ou no payload novo de boas-vindas. Resend e a caixa postal recebem o conteúdo legível como parte normal da entrega autorizada.
- O payload cifrado é persistido antes da chamada ao provedor. Retry e reinício reutilizam destinatário, conteúdo e chave de idempotência, sem gerar outro código/convite para a mesma mensagem.
- Mensagens novas têm chave `omnipdv-onboarding-<id>`. Há timeout de 30 segundos, backoff de 30 segundos até uma hora e no máximo oito tentativas ou 23 horas desde a primeira tentativa. Após a janela, exige revisão manual; não reenviar automaticamente fora da idempotência do Resend.
- Códigos expirados, solicitações consumidas e convites revogados tornam suas mensagens pendentes obsoletas/expiradas, sem enviar acessos inválidos. Um payload já tentado nunca é modificado para contornar conflito de idempotência.
- A aceitação pelo Resend não prova entrega na caixa postal. Acompanhar bounces/complaints no provedor e o estado da fila. `npm run billing:status` inclui totais da nova outbox sem destinatários, códigos ou URLs.
- Logs não contêm corpo de e-mail, token, código ou detalhes privados de erro do provedor. A auditoria grava emissão, comprovação, recuperação e vínculo com identificadores internos, sem segredos completos. Não habilitar tracking/analytics de URLs sensíveis.

## Novas variáveis e ativação manual futura

| Variável | Valor / finalidade |
| --- | --- |
| `AUTOMATIC_ONBOARDING_ENABLED` | Padrão `false`. `true` habilita a automação sem reconfigurar Stripe/Resend. |
| `ONBOARDING_OUTBOX_KEY_PATH` | Caminho absoluto fora do checkout para **32 bytes aleatórios brutos**, exclusivos da criptografia da outbox. Não é PEM, texto/base64 ou chave de assinatura de licença. |

A ativação exige `AUTH_ENABLED=true`, `AUTO_WELCOME_EMAIL_ENABLED=true`, `PRIVATE_DOWNLOAD_ENABLED=true`, instalador privado real, remetente/suporte/Resend já configurados e origem de autenticação HTTPS. A flag nova não liga sozinha os recursos anteriores. Se o instalador não existir, não for válido ou o envio estiver desligado, nenhum convite/código é enviado e a API informa indisponibilidade.

A chave da outbox é **nova e separada**; não alterar/regenerar a Ed25519 da licença nem as credenciais Stripe/Resend. Em uma implantação futura autorizada, se ainda não existir a chave da outbox, um operador pode criá-la uma única vez, por exemplo:

```bash
# Apenas instrução futura: não executado pela implementação.
# O diretório privado já deve existir e ter sido conferido.
sudo /usr/bin/node -e "require('node:fs').writeFileSync(process.argv[1],require('node:crypto').randomBytes(32),{flag:'wx',mode:0o600})" /srv/omnipdv-private/onboarding-outbox.key
sudo chown root:omnipdv /srv/omnipdv-private/onboarding-outbox.key
sudo chmod 0640 /srv/omnipdv-private/onboarding-outbox.key
```

`wx` recusa sobrescrita. **Se já existir, preservar o conteúdo.** Guardar backup criptografado com acesso restrito, separado do repositório. O systemd existente já permite leitura do diretório privado; conferir os caminhos/ACLs reais antes de habilitar. Não há keygen automático, valor no Git ou envio de chave ao cliente.

O banco registra uma impressão digital da chave na primeira habilitação; uma troca acidental é rejeitada antes de processar mensagens novas. A perda dessa chave impede decifrar mensagens e verificar índices/HMAC existentes. Não resolver gerando outra chave: restaurar a chave correspondente pelo procedimento seguro. Rotação de criptografia com múltiplas chaves exige projeto específico; não é feita automaticamente nesta fase.

## Migração 002 e compatibilidade

`db/migrations/002-automatic-onboarding.sql` é aplicada pelo ledger `auth_schema_migrations` numa transação após a versão 001. Adiciona somente:

- `onboarding_purchases`: origem da compra e destinatário cifrado, com índice HMAC;
- `onboarding_invites`: tokens hashed, expiração, consumo, revogação e material de entrega cifrado;
- `onboarding_verifications`: solicitações/códigos hashed/HMAC, prazo e tentativas;
- `onboarding_proofs`: comprovação temporária de e-mail vinculada ao convite;
- `onboarding_verified_emails`: índice de identidade comprovada para prevenir conta duplicada;
- `onboarding_outbox`: mensagens cifradas, lease, tentativas e resultado de envio;
- `onboarding_settings`: impressão digital da chave de outbox.

Não há ALTER/DROP das tabelas de contas, credenciais, sessões, convites administrativos, eventos, assinaturas, downloads ou entregas anteriores. Quando auth está ativo, as tabelas vazias podem ser criadas mesmo com automação desligada, sem disparar envios. Backup online SQLite inclui as novas tabelas automaticamente; a chave de outbox precisa de backup privado separado, como as chaves existentes.

**Dados existentes não são reenviados em massa.** Entregas já preparadas mantêm seu payload/chave originais e não são reescritas para acrescentar um convite. Mensagens já enviadas não são reenviadas. Convites automáticos são gerados nas novas preparações de boas-vindas após habilitar a automação. Contas existentes permanecem vinculadas. Compras históricas sem registro em onboarding_purchases continuam pelo suporte administrativo; não há varredura/backfill de contatos Stripe ou disparo retroativo nesta entrega.

## Rollback seguro

1. Parar o serviço pela rotina existente, aguardando HTTP e worker. Preservar snapshot consistente e a chave da outbox.
2. Desligar `AUTO_WELCOME_EMAIL_ENABLED` e `AUTOMATIC_ONBOARDING_ENABLED` antes de voltar código, após revisar os efeitos operacionais com o responsável.
3. Reverter somente a release/symlink para a base aprovada; **não restaurar SQLite antigo, apagar tabelas, limpar payloads, remover ledger ou alterar chaves**.
4. As contas/passkeys já criadas usam o mesmo schema 001 e continuam reconhecíveis. Convites automáticos não existem em auth_claims, portanto o código antigo os rejeita sem ignorar a verificação de e-mail.
5. Payloads antigos em texto JSON permanecem legíveis pelo sistema antigo. Payloads novos cifrados não devem ser reinterpretados, editados ou reenviados pela versão antiga; ficam preservados para retomar com o código e a chave corretos. Revisar a fila antes de religar envios.
6. Não redefinir first_at, contador ou chave de idempotência para tentar forçar reenvio. Conciliar entregas incertas com o Resend antes de revisão manual.

Restauração de banco antigo pode perder estado de consumo de convite, sessões, eventos e idempotência, inclusive duplicar mensagens. Tratar recuperação de dados como incidente separado, não como rollback rotineiro de código. Definir retenção de dados/ciphertexts/tokens expirados com a operação; esta fase não remove históricos automaticamente.

## Testes sem serviços reais

```bash
npm run check
npm test
```

Inclui fatura paga/recusada, webhook duplicado, convite/prova/código válidos e expirados, uso único, limite de tentativas, isolamento de compradores, reenvio recuperado com código, Resend incerto/reinício com mesmo payload/chave, destinatário congelado, conta existente, duplicidade de endereço comprovado, migração sobre versão 001, troca acidental de chave bloqueada, passkey com assinatura criptográfica real de teste e licença via PKCE.

Foi validado também no Chromium com passkey virtual e TLS local de teste: link, OTP separado por transporte simulado, registro, consentimento desktop, PKCE e licença. Nenhuma mensagem chega ao Resend real e nenhum recurso Stripe real é alterado. Para testes manuais futuros, usar somente clientes/cartões Sandbox e destinatário controlado, lembrando que uma API Resend real pode enviar e-mail real mesmo com pagamento de teste. Nenhum teste manual real foi executado nesta tarefa.

## Limitações deliberadas

- A mesma caixa postal não pode redefinir passkeys de uma conta já existente; suporte continua necessário se todas as credenciais forem perdidas.
- Mudança do e-mail original da fatura, endereço ausente ou recurso Stripe inconsistente exige verificação administrativa, sem redirecionamento automático para outra pessoa.
- Um link/código roubado não é proteção contra comprometimento completo da caixa postal; proteger a conta de e-mail é pré-requisito do primeiro vínculo.
- O desktop precisa implementar o protocolo de login/licença já documentado. Esta branch não altera o Electron, não cria atualização automática nem concede uma licença fora da política existente.
