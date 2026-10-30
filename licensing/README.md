# Fase A — contas e licenciamento OmniPVD

## Escopo e preservação

Esta fase adiciona login por passkey no navegador, autorização do desktop por código com PKCE, sessões revogáveis e uma API de licença com autorização offline Ed25519. `AUTH_ENABLED=false` é o padrão. Nenhuma chave real ou instalador é incluído. Nenhum envio, cobrança, alteração Stripe ou configuração live é acionado pela implementação/testes.

O Checkout e seus parâmetros não foram alterados. `billing/service.mjs`, `billing/runtime.mjs`, webhooks, fila Resend, downloads e idempotência mantêm o comportamento existente. A aplicação desktop Windows ainda precisa integrar o protocolo descrito aqui; o repositório da landing page não modifica o executável.

## Arquitetura e vínculo de identidade

`auth_accounts.id` é a identidade interna, independente de e-mail. `auth_stripe_links` associa uma conta a clientes Stripe verificados; um cliente de teste só pode pertencer a uma conta. Uma conta pode ter mais de um cliente verificado. O servidor nunca aceita e-mail ou `customer_id` enviado pelo desktop como seleção da licença.

Não há associação automática por igualdade de e-mail, ID Stripe, retorno do Checkout ou posse do link de download. Para preservar integralmente o Checkout atual, compras existentes e novas usam vinculação administrativa verificada nesta fase. Vinculação automática a partir de uma compra autenticada será uma evolução separada.

### Cadastro e procedimento do operador

1. Operador autorizado verifica a titularidade da compra por procedimento de suporte. Conhecer um e-mail, ID de cliente ou apresentar um recibo encaminhado não basta, isoladamente. Registre a referência da verificação no sistema de suporte, evite dados pessoais sensíveis no campo de referência.
2. No servidor privado, em terminal não gravado em logs compartilhados, execute:

   ```sh
   npm run auth:admin -- invite --customer cus_ID_VERIFICADO --verified-reference ticket-VERIFICADO
   ```

3. A ferramenta consulta apenas a existência do cliente de **teste** na Stripe. Isso não substitui a verificação humana do passo 1. Não há endpoint administrativo público ou credencial administrativa no aplicativo.
4. Um convite aleatório de uso único, válido por 30 minutos, aparece uma única vez no terminal. Entregue-o por canal seguro ao titular verificado. O banco guarda somente o hash. A URL usa fragmento `#invite=...`, removido pelo JavaScript ao abrir a página. Não registrar/copiar esse link em logs, tickets públicos ou analytics.
5. O titular abre o convite e cria uma passkey com verificação do usuário (PIN/biometria). Somente após a verificação criptográfica são criados conta, vínculo e sessão, em uma transação. E-mail não autentica esse processo.
6. O usuário deve cadastrar uma segunda passkey de segurança em `/account/login`. Também pode vincular outra compra, mediante novo convite verificado, após login e proteção CSRF.

O cadastro exige passkey discoverable/resident com user verification. Login utiliza RP ID e origem exatos. Mudar o domínio de autenticação pode tornar passkeys existentes inutilizáveis: escolha um domínio estável antes de ativar.

**Recuperação automática não foi implementada.** Se todas as passkeys forem perdidas, não há redefinição por e-mail nem reatribuição automática de cliente Stripe. Bloqueie a conta se necessário e trate a recuperação por procedimento administrativo específico e auditado antes de restaurar acesso. Não edite vínculos informalmente nem remova registros para contornar a verificação.

## Configuração opt-in

Requer Node.js 24, HTTPS, uma única instância e o volume SQLite privado já utilizado pelo billing. Não requer novo banco ou provedor de identidade externo. As migrações são aplicadas apenas quando o licenciamento é habilitado e usa o banco existente. Faça backup SQLite consistente antes de ativar, incluindo o estado de WAL por procedimento adequado.

| Variável nova | Padrão / uso |
| --- | --- |
| `AUTH_ENABLED` | `false`; somente `true` habilita a fase A |
| `AUTH_ORIGIN` | Origem HTTPS sem barra final do login, também emissor das licenças |
| `AUTH_RP_ID` | Host exato dessa origem, sem protocolo/porta |
| `AUTH_ALLOW_LOCALHOST` | `false`; `true` permite HTTP localhost/127.0.0.1 somente em desenvolvimento |
| `AUTH_ACCESS_TTL_SECONDS` | `600`, limites 60–900 |
| `AUTH_SESSION_TTL_SECONDS` | `2592000` (30 dias absolutos), limites 3600–2592000 |
| `AUTH_BROWSER_TTL_SECONDS` | `43200` (12 horas), limites 300–86400 |
| `LICENSE_PRIVATE_KEY_PATH` | Caminho absoluto do PEM Ed25519 privado, fora do checkout |
| `LICENSE_SIGNING_KEY_ID` | `phase-a-1`, identificador público da chave |
| `LICENSE_OFFLINE_TTL_SECONDS` | `14400` (4 horas), limites 60–14400 |
| `LICENSE_RECHECK_SECONDS` | `900` (15 minutos), limites 30–3600 |

`STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` e `BILLING_DB_PATH` permanecem os existentes. Não há nova credencial Stripe/Resend ou chave administrativa no frontend. Esta fase aceita somente vínculos e recursos Stripe de teste, em coerência com os webhooks existentes. Não ativar cobrança live nesta entrega.

Gere a chave privada em diretório privado fora do projeto:

```sh
npm run license:keygen -- /CAMINHO/PRIVADO/omnipvd-license.pem
```

No Windows, use um caminho absoluto privado como `C:\omnipvd-private\license.pem`. O comando cria o arquivo com exclusividade (não sobrescreve), usa permissões restritas onde suportadas e imprime somente a chave pública. Proteja chave, diretório, banco e backups; configure ACLs no Windows. Não reutilize a chave Stripe como chave de assinatura.

Para desenvolvimento local: `AUTH_ORIGIN=http://localhost:3000`, `AUTH_RP_ID=localhost`, `AUTH_ALLOW_LOCALHOST=true`, `DOMAIN=http://localhost:3000`. Em produção, HTTPS e `AUTH_ALLOW_LOCALHOST=false`. O suporte a passkeys locais depende do navegador/autenticador e é separado da licença offline.

## Migrações e tabelas

`db/migrate.mjs` aplica `db/migrations/001-licensing.sql` com transação e ledger `auth_schema_migrations`. Não há DROP, TRUNCATE, reset, alteração de entregas ou reutilização do `user_version` de outro componente. A reaplicação é idempotente. Quando desativado, as tabelas permanecem no disco e as funcionalidades anteriores continuam disponíveis.

Novas tabelas: `auth_accounts`, `auth_stripe_links`, `auth_claims`, `auth_credentials`, `auth_challenges`, `auth_sessions`, `auth_access_tokens`, `auth_refresh_tokens`, `auth_codes`, `license_entitlements`, `auth_rate_limits`, `auth_audit` e o ledger de migrações.

Credenciais WebAuthn persistem chaves **públicas** e contadores, nunca a chave privada da passkey. Códigos, convites, cookies e tokens de sessão são indexados por hash. O banco contém informações pessoais/comerciais: não publicá-lo e aplicar política de retenção, backups e acesso restrito. A fase A não inclui limpeza automática dos históricos/tokens expirados; a validade é sempre aplicada nas consultas.

## Endpoints

| Método e rota | Uso |
| --- | --- |
| `GET /account/login` | Página de conta, cadastro por convite e consentimento |
| `POST /api/auth/passkeys/register/options` e `/verify` | Convite verificado ou sessão browser com CSRF para adicionar passkey |
| `POST /api/auth/passkeys/login/options` e `/verify` | Autenticação WebAuthn com desafio de 5 minutos, consumido uma vez |
| `GET /api/auth/session` | Sessão browser e novo token CSRF para a página |
| `POST /api/account/claim` | Vincular outra compra à conta autenticada com convite e CSRF |
| `GET /api/auth/authorize` | Validar solicitação PKCE e abrir página de consentimento |
| `POST /api/auth/authorize` | Consentimento browser autenticado com CSRF; emitir código de 60 segundos |
| `POST /api/auth/token` | Troca de código ou rotação do refresh token |
| `POST /api/auth/logout` | Revogar a sessão atual |
| `GET /api/auth/sessions` | Listar somente sessões da própria conta |
| `POST /api/auth/sessions/revoke` | Revogar uma sessão própria, pelo navegador com CSRF |
| `GET /api/license/status` | Licença da conta autenticada do desktop, sem parâmetros de seleção |
| `GET /.well-known/omnipvd-license-keys.json` | Chave pública Ed25519 ativa (JWKS) |

Login/browser exige origem exata. Escritas exigem JSON; operações de conta exigem cookie HttpOnly, SameSite=Strict e CSRF. Cookies Secure são obrigatórios fora do localhost de desenvolvimento. Adicionar passkey ou vincular outra compra exige autenticação recente (até cinco minutos); fora desse prazo, sair e entrar novamente. O frontend de conta não guarda tokens de desktop em localStorage ou sessionStorage, não tem scripts remotos e usa CSP restrita.

O limite é persistente: 180 requisições de autenticação/licença por minuto por IP de socket, 15 logins/verificações por minuto por IP, 10 cadastros por minuto por IP, 30 trocas de token por minuto por IP e 30 consultas de licença por minuto por conta. Outras operações de conta têm limite de 30/minuto. Retorna 429 com `Retry-After`. `X-Forwarded-For` não é confiado: atrás de um proxy, clientes podem compartilhar o limite do proxy. Antes de escalar, configurar uma política de proxy/limites no provedor sem confiar cegamente em cabeçalhos do usuário.

## Protocolo desktop

É um protocolo próprio de primeira parte usando authorization code + PKCE S256 e callback loopback; não é um servidor OAuth genérico nem uma implementação OIDC.

1. O desktop gera `state` aleatório (32 bytes), `code_verifier` criptográfico de 43–128 caracteres e `code_challenge=BASE64URL(SHA256(verifier))`, sem padding. Gera também um `installation_id` aleatório persistente. Não usa segredo de cliente embutido.
2. Antes de abrir o navegador, inicia um listener **somente em 127.0.0.1**, em porta efêmera livre, caminho `/omnipvd/callback`. Não abrir em interfaces públicas.
3. Abre navegador externo com:
   - `client_id=omnipvd-desktop`, `response_type=code`;
   - `code_challenge_method=S256`, desafio e `state`;
   - `installation_id` de 16–128 caracteres base64url, `device_name` opcional;
   - `redirect_uri=http://127.0.0.1:PORTA/omnipvd/callback`.
4. O usuário autentica com passkey e confirma o dispositivo no navegador. O backend aceita somente callback HTTP nesse IP, porta >=1024, caminho exato, sem credenciais/query/fragmento prévio. Redireciona com `code` e o mesmo `state`.
5. O desktop compara `state` em tempo constante, rejeita callbacks inesperados e troca uma única vez por JSON em `POST /api/auth/token`:
   `grant_type=authorization_code`, `client_id`, `code`, `code_verifier`, `redirect_uri` idêntico.
6. A resposta inclui `access_token`, `refresh_token`, `expires_in`, `account_id`, `session_id`, `installation_id` e expiração absoluta da sessão. Guarda refresh token protegido com Windows Credential Manager/DPAPI; access token em memória. Nunca inserir tokens em URL/logs.
7. Consulta `GET /api/license/status` com `Authorization: Bearer ACCESS_TOKEN`.
8. Renova com JSON `grant_type=refresh_token`, `client_id=omnipvd-desktop`, `refresh_token`. Substitui o refresh local atomicamente. A validade absoluta de 30 dias não é estendida. Reutilização de refresh consumido revoga a sessão inteira. Serializar refresh no aplicativo; não repetir automaticamente um refresh de resultado incerto: iniciar login novamente para evitar replay.

O navegador externo pode estar autenticado previamente, mas o consentimento do aplicativo continua explícito. Não aceitar pedido de autorização iniciado por terceiro. Device name e installation ID são identificação lógica, não atestado de hardware ou prova de posse de chave do dispositivo.

## Decisão de licença e indisponibilidade

A licença usa somente os clientes Stripe vinculados à conta autenticada. Consulta assinaturas atuais e faturas na Stripe, com paginação e limites de recursos que falham fechados. Confirma:

- cliente e recurso de teste corretos;
- Price licenciado presente;
- fatura inicial `subscription_create` efetivamente paga;
- última fatura da mesma assinatura paga;
- linha recorrente do Price licenciado com período corrente ainda válido;
- assinatura `active`, conta habilitada e sessão não revogada.

Não utiliza a fila de e-mail ou o link de download como prova de pagamento. Renovações pagas atualizam o período. Trial sem pagamento inicial, inadimplência, sessão/conta revogada e assinatura cancelada são negados. Cancelamento agendado permite acesso enquanto ativa e dentro do período pago. Não há tolerância automática a inadimplência. Planos com trial/conversão cuja primeira fatura paga não seja `subscription_create` ou cenários complexos de proration exigem política adicional antes de serem oferecidos; não há concessão implícita de licença nesses casos.

A resposta contém apenas `authorized`, `subscription_status`, `authorization_expires_at`, `next_check_at` e `offline_authorization` (ou null). Não há IDs Stripe ou dados de cartão. Query params tentando selecionar outra conta são rejeitados. Sem assinatura: 200 com acesso negado; sessão inválida/expirada: 401; indisponibilidade da Stripe/backend: 503 sem novo token offline. Não converter 503 em cancelamento nem emitir autorização positiva a partir de cache antigo.

## Offline e chaves públicas

Licença assinada JWS Ed25519 (`alg=EdDSA`, `typ=omnipvd-license+jwt`) contém `iss`, `aud`, `sub`, `sid`, `installation_id`, produto, `jti`, `iat`, `nbf`, `exp` e autorização. `exp` é o mínimo entre agora+4h, fim do período pago e fim absoluto da sessão. Consulta online recomendada em 15 minutos ou antes do vencimento, o que ocorrer primeiro.

Distribua ao aplicativo somente a chave pública confiável (ou JWKS buscado da origem HTTPS fixada e validada), jamais a chave privada/Stripe/Resend. Não aceitar chaves ou URLs de chave fornecidas pelo próprio token. Use biblioteca confiável no desktop para verificar algoritmo fixo, assinatura, issuer, audience, tipo, identificadores de conta/sessão/instalação e todas as datas. `licensing/service.mjs` fornece `verifyOfflineLicense()` como referência verificável, mas não instala o cliente Windows.

Não basta ler o payload do JWT. O cliente não pode editar `exp` sem invalidar a assinatura. Persistir referências de tempo confiáveis protegidas por DPAPI; detectar relógio regressivo e exigir reconexão. Ao expirar, exigir nova validação online. Desinstalar/copiar arquivos não deve gerar novo prazo. Um sistema operacional ou executável adulterado pode ignorar verificações: a fase A não promete impedir cracking ou clonar hardware.

Revogação online bloqueia novas consultas/tokens. Uma licença já assinada pode continuar válida offline por até quatro horas: não há revogação instantânea sem conexão. Em indisponibilidade da Stripe, somente essa licença anterior pode continuar até o `exp` original, sem estender. Chaves públicas anteriores devem ser mantidas confiáveis no cliente até suas licenças expirarem durante uma rotação planejada. Rotacionar chave/ID no servidor sem atualizar a distribuição das públicas pode interromper clientes; não há rotação automática nesta fase.

## Administração e recuperação

Operações somente no servidor privado, com acesso de operador confiável, sem endpoint de administração:

```sh
npm run auth:admin -- revoke-sessions --account ID_INTERNO --verified-reference ticket-VERIFICADO
npm run auth:admin -- disable --account ID_INTERNO --verified-reference ticket-VERIFICADO
```

Revogam sessões, não alteram assinaturas ou cobranças Stripe. Bloquear conta impede login e novas autorizações, sem apagar billing ou entregas. A auditoria registra ação, referências e horário sem códigos/tokens completos. Não há endpoint de recuperação por e-mail, transferência de cliente ou remoção irrestrita de credenciais.

## Testes e implantação

```sh
npm ci
npm run check
npm test
```

Os testes usam chaves/passkeys criptográficas sintéticas, Stripe/Resend simulados, banco temporário e relógio controlado. Verificam sessões persistidas após fechar/reabrir o arquivo, migração sobre dados existentes, contas isoladas, assinatura ativa/ausente/cancelada, expiração, pagamento recusado e renovado, tokens inválidos/expirados, PKCE, códigos/convites de uso único, replay de refresh, CSRF, limites, falha do backend/Stripe e assinatura/expiração offline. A suíte de billing/Checkout/e-mail/download permanece em execução.

Também foi validado localmente no Chromium com autenticador virtual: cadastro e login por passkey, cookie HttpOnly, consentimento, callback loopback, PKCE, troca de token, consulta sem assinatura e layout móvel. Esse teste não utilizou clientes ou pagamentos reais.

Antes de ativar na hospedagem: backup consistente, domínio estável com HTTPS, chave privada/ACLs, variáveis seguras, conta de teste vinculada por operador, teste ponta a ponta com desktop de desenvolvimento e política de recuperação/dispositivos definida. Esta fase não impõe limite comercial de dispositivos. `AUTH_ENABLED=false` permite desativar as rotas novas sem apagar tabelas ou alterar billing. Não faça rollback do arquivo SQLite para um backup antigo sem reconciliar as entregas já realizadas no Resend.
