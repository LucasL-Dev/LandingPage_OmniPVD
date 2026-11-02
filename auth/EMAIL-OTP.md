# Login por e-mail e código — OmniPDV

Branch: `feat/email-otp-authentication`, base `feat/production-integration` (inclui onboarding automático). Esta implementação não faz deploy, não modifica o Electron/VPS e não altera credenciais nem a chave Ed25519. Stripe permanece Sandbox. Passkeys, convites administrativos/automáticos antigos, sessões, Checkout, webhooks, licenciamento e downloads continuam disponíveis.

## Habilitação futura

Nova variável, adicionada aos dois exemplos de ambiente:

```dotenv
EMAIL_OTP_AUTH_ENABLED=false
```

Ativar manualmente somente após backup consistente e revisão operacional. Exige `AUTOMATIC_ONBOARDING_ENABLED=true` e suas configurações existentes: autenticação, Resend, boas-vindas, instalador privado real, HTTPS e `ONBOARDING_OUTBOX_KEY_PATH`. Reutiliza a mesma chave de 32 bytes e sua impressão digital; **não gerar novamente essa chave nem a Ed25519**. A flag não liga pagamentos live. As configurações inválidas falham na inicialização. A página consulta `/api/auth/config`; com a flag desligada, não oferece OTP e seus endpoints retornam indisponibilidade. O worker não envia mensagens de login pendentes enquanto a flag estiver desligada.

## Confiança e fluxo do comprador

1. O webhook existente verifica a assinatura Stripe e registra a fatura inicial paga. A fila de boas-vindas confirma a assinatura, mantém o instalador privado e registra o cliente Stripe e o e-mail original da fatura em `onboarding_purchases`. Não usa o contato mutável de `customer.email` para autenticar.
2. Com OTP habilitado, boas-vindas novas incluem instruções e `/account/login`, sem exigir convite/passkey. Payloads e entregas históricos não são reescritos nem reenviados. O índice de compras é preparado quando a fila processa boas-vindas; se o worker/instalador não estiver pronto, não se inventa um acesso.
3. O comprador abre o login na origem da API, informa o e-mail e solicita o código. Só uma compra registrada, com cliente ainda não vinculado e sem identidade antiga conflitante, é elegível ao primeiro acesso. Conhecer o endereço, `session_id`, token de download ou ID Stripe não autoriza nada.
4. A fila envia um código aleatório de seis dígitos para o destinatário cifrado da compra. Ao confirmar o código, o backend consulta novamente a fatura inicial e a assinatura na Stripe, valida Sandbox, cliente, assinatura, Price e destinatário original.
5. O código é consumido de forma atômica. Depois da consulta à Stripe, a criação da conta, o vínculo único ao cliente, a identidade OTP e a sessão ocorrem numa transação com nova checagem dos vínculos. Outra solicitação/convite que tenha vinculado o cliente nesse intervalo impede o cadastro. Convites automáticos ainda pendentes desse cliente são invalidados.
6. A sessão browser usa o cookie HttpOnly existente. O usuário confirma o aplicativo solicitado; código de autorização curto e PKCE entregam tokens somente ao processo desktop. A API de licença consulta o estado atual da assinatura; OTP nunca é uma licença.

Assinatura cancelada/inadimplente pode permitir identificar o titular e entrar na conta, mas `/api/license/status` nega o uso do aplicativo. Revogação/bloqueio de conta e sessão são respeitados. Falha temporária Stripe não cria vínculo ou sessão nova. Um código já consumido numa tentativa que falhou não é reutilizado: solicitar outro após a recuperação do serviço.

## Contas anteriores e compras com o mesmo e-mail

**Não há migração automática de contas legadas por e-mail.** O primeiro login OTP não pode assumir um cliente já vinculado, mesmo que o endereço coincida. Não altera ou apaga contas, passkeys e vínculos anteriores.

Política explícita de migração:

1. Entrar pelo método existente, normalmente passkey, na conta correta.
2. Em até cinco minutos, abrir “Habilitar login por e-mail nesta conta”. A solicitação exige sessão, origem exata e CSRF.
3. Informar o endereço original de uma compra **já vinculada a essa conta**. Para compras históricas sem registro de onboarding, apenas neste fluxo autenticado o backend pode importar o destinatário da fatura inicial paga indicada na entrega existente. Não pesquisa compradores anônimos na Stripe nem altera a entrega original.
4. Confirmar o código enviado àquele endereço, na mesma sessão e navegador. Isso registra a adesão auditada, mantendo o mesmo ID de conta e todas as passkeys. Códigos de adesão não podem ser usados no endpoint público de login.
5. A partir daí, códigos futuros autenticam somente a identidade registrada. Passkeys continuam opcionais e podem ser adicionadas depois de login recente.

Compras ambíguas (mais de um cliente elegível com o mesmo endereço), endereço já comprovado em outra conta, compras vinculadas a contas diferentes e conta sem fatura original verificável exigem suporte. Não se mesclam contas nem se anexam novas compras por coincidência de e-mail. Depois de criada a identidade OTP, outras compras no mesmo endereço não são automaticamente vinculadas. Convites verificados e suporte existentes permanecem disponíveis. Perda de todas as passkeys antes de aderir ao OTP requer suporte com comprovação independente; não há botão de recuperação que contorne essa política.

## Endpoints browser

Todos ficam em `https://api.omnipdv.com.br`; nenhuma rota OTP recebe CORS da landing. POST exige JSON e `Origin` exata da API. Não chamar os endpoints OTP diretamente do renderer Electron nem adicionar uma origem `file://` ou CORS wildcard.

| Método / caminho | Contrato |
| --- | --- |
| GET `/api/auth/config` | `{email_otp_enabled: boolean}`; sem informações de usuário |
| POST `/api/auth/email-otp/request` | `{email, requestKey}` → `{ok:true, requestId}` |
| POST `/api/auth/email-otp/verify` | `{requestId, code}` → `{ok:true}` + cookie de sessão; sem tokens desktop |
| POST `/api/auth/email-otp/enroll/request` | Mesmo corpo de request; exige sessão recente + `X-CSRF-Token` |
| POST `/api/auth/email-otp/enroll/verify` | Mesmo corpo de verify; exige a mesma sessão recente + CSRF |
| GET `/api/auth/session` | Sessão atual e token CSRF |
| POST `/api/auth/logout` | Revoga sessão atual; browser exige CSRF |
| GET `/api/auth/sessions` | Lista somente sessões da própria conta |
| POST `/api/auth/sessions/revoke` | `{session_id}`; browser autenticado com CSRF |
| POST `/api/auth/token` | Troca PKCE ou refresh rotativo existentes |

`requestKey`: 32 bytes aleatórios codificados base64url, 43 caracteres, gerados pela página. Retentar uma requisição com resultado de rede incerto preserva a chave e o mesmo navegador; não duplica e-mail. Um reenvio intencional usa chave nova e conta no limite do destinatário. `requestId` é opaco, não é um token de acesso. `code` é string de exatamente seis dígitos, preservando zeros iniciais.

O servidor vincula o desafio a `omnipdv_otp`, cookie aleatório HttpOnly, Secure, SameSite=Strict, caminho `/api/auth/email-otp`, duração de dez minutos. A verificação exige esse cookie; transportar apenas requestId/código para outro navegador não autentica. A página mantém identificadores/códigos somente em memória e não grava credenciais em storage. Após sucesso, limpa o cookie temporário. A validade efetiva do desafio é absoluta e não se estende ao retentar o envio.

Destinatário desconhecido, compra não elegível e conta legada não habilitada recebem o mesmo status/corpo de solicitação e nenhum envio. Não há consulta Stripe dependente da existência da conta no endpoint público de solicitação. A confirmação inválida recebe erro genérico, sem indicar qual campo falhou. Não registrar corpos, cookies, códigos, e-mails completos ou URLs sensíveis no proxy/aplicação/analytics.

## Proteções e entrega

- Geração por `crypto.randomInt(0, 1_000_000)`, dez minutos absolutos, cinco tentativas máximas, uso único. Código verificável somente por HMAC com a chave privada já existente da outbox. Não há código em texto aberto no banco: o material necessário ao envio é cifrado AES-256-GCM pela fila existente.
- Tentativas erradas são persistidas mesmo em respostas de erro. Replay/conferências concorrentes falham; os índices únicos e `BEGIN IMMEDIATE` impedem duplicação de vínculo/identidade. Vinculação é revista depois de operações assíncronas.
- Limites persistentes: três solicitações novas/hora por destinatário HMAC, dez requisições/minuto e sessenta/hora por IP de socket, mais o limite global de autenticação. Resposta 429 inclui Retry-After (orientação mínima; a janela de destinatário continua de uma hora).
- X-Forwarded-For não é confiado. Atrás do Caddy atual, o limite de socket é compartilhado pelo proxy e conservador. Para escalar, projetar identificação de IP apenas de proxies explicitamente confiáveis antes de relaxar limites. Não confiar em cabeçalhos fornecidos pelo visitante.
- Entrega pelo mesmo worker, sem timer/processo adicional. Outbox cifrada persistida antes do envio, payload imutável e chave Resend `omnipdv-onboarding-<id>` reutilizados no retry. Lease/timeout/backoff e janela de idempotência existentes preservados. Falha do Resend não autentica ninguém; códigos expirados/consumidos tornam mensagens obsoletas. Não reutilizar chave com payload diferente.
- Consentimento desktop permanece explícito com proteção CSRF. O callback contém apenas código de autorização de uso único (60 segundos) e state; nunca access/refresh tokens. A troca valida S256, URI de loopback exata e sessão/conta. Refresh é rotativo; replay revoga a sessão desktop.

OTP verifica controle atual da caixa postal. Comprometimento do e-mail passa a permitir login nas contas que aderiram a essa modalidade; esta é a mudança de política de autenticação solicitada. Passkeys opcionais não tornam OTP um segundo fator. Proteger a caixa postal e acompanhar abuso, bounces e reclamações de envio.

## Migração SQLite e rollback

Migração **003**, aditiva e transacional pelo ledger existente:

- `auth_email_identities`: HMAC do endereço, conta, cliente Stripe e momento da adesão.
- `auth_email_challenges`: solicitação/idempotência, hash do cookie de vinculação, cliente/conta/escopo de adesão, HMAC do código, expiração, tentativas e consumo.

Não há ALTER/DROP/reset de tabelas antigas. O backup SQLite existente inclui essas tabelas; manter também o backup privado da chave de outbox. Faça backup online consistente antes de implantar; não copiar somente o arquivo principal com WAL ativo. Não foi acessado banco de produção nesta tarefa.

Rollback funcional preferido: desligar apenas `EMAIL_OTP_AUTH_ENABLED`, reiniciar pela rotina operacional existente e preservar SQLite/chaves. Novos logins OTP e envios OTP param; passkeys e sessões válidas continuam, inclusive desktop. Contas criadas por OTP sem passkey não conseguirão fazer novo login enquanto o recurso estiver desativado; oferecer suporte e considerar cadastrar passkey antes de desligar.

Para voltar código: drenar servidor/worker e preservar tabelas/ledger/outbox. Não restaurar banco antigo, remover contas sem credenciais, apagar desafios, reabrir convites usados, limpar payloads ou reiniciar idempotência. Código anterior pode desconhecer mensagens `purpose=login`; **desligar envios automáticos antes de reverter código**, conforme rollback do onboarding. Contas/sessões usam schema original e permanecem reconhecíveis. Restaurar dados antigos pode reativar códigos e convites consumidos: não é rollback de rotina.

## Validação local sem serviços reais

```sh
npm ci
npm run check
npm test
```

Testes usam Stripe/Resend simulados, SQLite/instalador temporários, chave Ed25519 efêmera e verificações WebAuthn reais de teste. Não enviar e-mails reais ou mudar assinaturas para testar esta branch. Abrangem pagamentos, passkeys legadas, identidade, código incorreto/expirado/repetido, concorrência, bloqueio, migração explícita, transporte/cookies/origem/CSRF, rate limits, retries/reinício e licenciamento. Integração Windows: [WINDOWS-EMAIL-OTP.md](../docs/WINDOWS-EMAIL-OTP.md).
