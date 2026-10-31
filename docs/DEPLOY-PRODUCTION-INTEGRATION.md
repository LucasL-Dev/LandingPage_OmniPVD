# Guia definitivo — integrar na VPS existente sem substituir dados

Branch de implantação: **`feat/production-integration`**.

Base: `feat/ubuntu-vps-deployment`; integração: `feat/static-landing-hostinger`. Ubuntu 24.04 LTS, Node.js 24, Caddy, Git e firewall já estão instalados. O checkout de desenvolvimento existe em `~/omnipdv-src`.

**Este roteiro é para execução manual futura pelo operador. Nada foi implantado; nenhuma alteração em DNS, Stripe, Resend, Hostinger ou main foi executada.** Infraestrutura de produção usa exclusivamente Stripe Sandbox/teste nesta etapa.

## 1. Arquitetura final e invariantes

| Destino | Responsabilidade |
| --- | --- |
| `https://omnipdv.com.br` | Landing Page estática, já publicada na hospedagem compartilhada; não mudar seu DNS nem copiá-la para a VPS |
| `https://api.omnipdv.com.br` | Caddy → `127.0.0.1:3000`, backend Node, Checkout, webhooks, conta/passkeys, licenças e download privado |
| `/opt/omnipdv/releases/<SHA>` | Código rastreado e dependências da revisão aprovada, somente leitura para o serviço |
| `/opt/omnipdv/current` | Symlink para a release ativa, fora do diretório home |
| `/etc/omnipdv/backend.env` | Ambiente privado já existente ou criado uma única vez pelo operador |
| `BILLING_DB_PATH` existente | SQLite/WAL/SHM persistentes, fora da release; não substituir por banco vazio |
| `LICENSE_PRIVATE_KEY_PATH` existente | Mesma chave Ed25519 e `kid`; não gerar outra ao atualizar |
| `PRIVATE_INSTALLER_PATH` existente | Instalador real privado, fora do checkout/public_html |

Caddy nunca usa `file_server` ou `root` para o repositório. Não criar Nginx concorrente, PM2/cluster ou segundo worker. O worker Resend é serializado no mesmo processo Node; systemd e flock mantêm uma instância. A porta Node não é pública.

## 2. Antes de executar: inventário privado e pontos de parada

1. Confirmar o status de `omnipdv.service`, `omnipdv-backup.timer` e `caddy`. Se um serviço ainda não existir, isso não é motivo para apagar dados ou recriar o repositório.
2. Conferir, em editor privado, os caminhos atuais do SQLite, chave de licença, JWKS de transição, instalador e arquivo de ambiente. Não executar `printenv`, `cat` do ambiente em logs compartilhados, `systemctl show ... Environment` ou `source` de EnvironmentFile.
3. Verificar **existência e tamanho do banco atual** e permissões, usando o caminho real já configurado. Por exemplo, somente se este for realmente o caminho atual:

   ```bash
   sudo test -s /var/lib/omnipdv/billing.sqlite
   sudo stat -c '%a %U %G' /var/lib/omnipdv /var/lib/omnipdv/billing.sqlite
   ```

   Se o banco esperado não existir, **parar** e localizar os dados ou backup válido. Não iniciar o backend apontando para um novo caminho: a funcionalidade de primeira instalação pode criar um esquema vazio, o que não recupera os clientes existentes.
4. Conferir que o Node real é 24.x e que o caminho da unidade aponta para esse executável. Não reinstalar Node, Caddy ou firewall que já funcionam.
5. Guardar backup privado das unidades e do Caddyfile atuais e referência da release ativa. Preservar outros hosts/configurações do Caddy. Não copiar configurações com segredos para o repositório.
6. Se o RP ID/issuer atual for diferente de `api.omnipdv.com.br`, **parar a troca de domínio** até resolver a compatibilidade do desktop e das passkeys conforme seção 10. Não renomear credenciais, recriar contas ou transferir clientes por igualdade de e-mail.

Se dados/chaves estiverem atualmente dentro de `~/...`, o sandbox do serviço (`ProtectHome=true`) não poderá acessá-los. Planejar uma migração privada com backup consistente, serviço de origem parado e verificação da cópia; não mover/apagar os originais de forma improvisada. O exemplo de diretórios não autoriza substituir os caminhos existentes sem esse procedimento.

## 3. Backup consistente antes da mudança

Se o serviço de backup já estiver configurado, usar manualmente:

```bash
sudo systemctl start omnipdv-backup.service
sudo systemctl status omnipdv-backup.service --no-pager
sudo journalctl -u omnipdv-backup.service -n 10 --no-pager
```

Confirmar `backup_completed` e existência do snapshot no diretório privado configurado. O script usa a API online SQLite, captura WAL ainda não checkpointado, restringe permissões **antes** da cópia, faz `quick_check`, fsync e publicação por rename. Recusa fonte inexistente, sem criar banco de origem vazio.

Se a unidade não existir, configurar primeiro a rotina de backup com os **caminhos reais** existentes; usar a referência [DEPLOY-UBUNTU.md](DEPLOY-UBUNTU.md), seção de backup. Nunca copiar somente `.sqlite` aberto ignorando WAL. Proteger e copiar chave privada/ambiente/instalador por rotina de backup segura e criptografada já adotada; o snapshot SQLite não inclui esses arquivos. Não imprimir ou regenerar chaves. Não manter a única cópia no mesmo disco da VPS.

## 4. Revisar a branch no checkout já existente

Como o usuário operador, sem executar npm como root:

```bash
cd ~/omnipdv-src
git status --short
git fetch origin refs/heads/feat/production-integration:refs/remotes/origin/feat/production-integration
git switch --detach origin/feat/production-integration
node --version
npm ci
npm run check
npm test
```

Se houver alterações locais, pare e preserve-as antes de trocar a revisão. Não usar `reset --hard`, `clean`, reclonar por cima de `~/omnipdv-src` ou dar `git pull` na release ativa. Nenhum comando acima faz merge na main. Os testes usam recursos temporários e mocks; não chamam Stripe/Resend reais.

O checkout é área de desenvolvimento, não diretório do serviço. Não há necessidade de republicar a Landing Page já funcionando: o frontend continua chamando a mesma API definitiva. O build estático permanece disponível separadamente, conforme [hostinger-static.md](deploy/hostinger-static.md).

## 5. Preparar uma release sem copiar arquivos privados

Depois de revisar a revisão e os testes, como operador normal:

```bash
set -euo pipefail
cd ~/omnipdv-src
DEPLOY_REVISION=$(git rev-parse HEAD)
DEPLOY_RELEASE="/opt/omnipdv/releases/$DEPLOY_REVISION"
if [ -e "$DEPLOY_RELEASE" ]; then
  echo 'Release já existe; interrompa e confira sem sobrescrever.'
  exit 1
fi
sudo install -d -m 0755 /opt/omnipdv/releases
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 "$DEPLOY_RELEASE"
git archive --format=tar "$DEPLOY_REVISION" | tar -x -C "$DEPLOY_RELEASE"
npm --prefix "$DEPLOY_RELEASE" ci
npm --prefix "$DEPLOY_RELEASE" run check
npm --prefix "$DEPLOY_RELEASE" test
sudo chown -R root:root "$DEPLOY_RELEASE"
```

`git archive` inclui somente arquivos rastreados da revisão, não `.env` ignorado, dados privados, ZIP gerado ou node_modules do checkout. Dependências são instaladas na release pelo operador e depois bloqueadas para o usuário do serviço. Não usar `cp -a .` para publicar. A aplicação roda como `omnipdv`, não como root. Se esse usuário/diretório ainda não existir, criar apenas os recursos ausentes seguindo a referência Ubuntu, sem alterar permissões de bancos/chaves existentes indiscriminadamente.

## 6. Atualizar o ambiente sem substituí-lo

Revisar manualmente o **arquivo já usado pelo serviço**, com `sudoedit`. Não instalar `ops/backend.env.example` por cima do arquivo atual. O exemplo é uma referência de nomes, não uma configuração pronta com segredos.

Alterações de origem necessárias (sem barra final):

```dotenv
DEPLOY_ENV=production
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
SITE_ORIGIN=https://omnipdv.com.br
API_ORIGIN=https://api.omnipdv.com.br
AUTH_ORIGIN=https://api.omnipdv.com.br
AUTH_RP_ID=api.omnipdv.com.br
AUTH_ALLOW_LOCALHOST=false
DOWNLOAD_ORIGIN=https://api.omnipdv.com.br
```

`DOMAIN` é somente alias legado comercial quando SITE_ORIGIN não existe. Remover seu uso conceitual como origem da API; SITE_ORIGIN tem precedência. A validação de staging/production agora exige site e API HTTPS distintos, AUTH_ORIGIN/DOWNLOAD_ORIGIN iguais à API e RP ID exato. Isso resolve a incompatibilidade entre as branches, que antes exigia uma origem única.

**Preservar valores atuais e verificados**, sem copiá-los para este guia:

- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`: somente chaves `sk_test_`/`rk_test_` e recursos Stripe de teste; nenhum modo live habilitado.
- `BILLING_DB_PATH`, `BACKUP_DIR`: banco e backups persistentes atuais; não apontar para diretório novo vazio.
- `LICENSE_PRIVATE_KEY_PATH`, `LICENSE_SIGNING_KEY_ID`, `LICENSE_PREVIOUS_PUBLIC_KEYS_PATH`: chave atual, `kid` e conjunto anterior somente público; não executar keygen para atualizar código.
- `PRIVATE_INSTALLER_PATH`, `MAX_INSTALLER_BYTES`, `MAX_CONCURRENT_DOWNLOADS`: instalador real e limites existentes. Arquivo vazio/superdimensionado continua bloqueado.
- `RESEND_API_KEY`, `RESEND_FROM`, `SUPPORT_EMAIL`: mesmo remetente validado, sem mudança de conta/provider.
- `AUTH_ENABLED`, `PRIVATE_DOWNLOAD_ENABLED`, `AUTO_WELCOME_EMAIL_ENABLED`: manter estado deliberadamente validado. O perfil VPS exige autenticação ativa; não ligar envios por copiar um exemplo. Envios habilitados podem processar jobs pendentes após reinício.
- TTLs de sessão/licença e `QUEUE_INTERVAL_SECONDS`: preservar política já validada; padrões de offline não excedem quatro horas.

EnvironmentFile do systemd não expande comandos/variáveis de shell. Em staging/production o Node **não lê `.env` do checkout**. Permissões do ambiente: root:root 0600, entregue pelo systemd ao processo. Nenhum segredo deve estar no usuário desktop, nos seis arquivos estáticos ou no Caddyfile.

## 7. Revisar systemd e Caddy existentes

### systemd

Compare `ops/systemd/omnipdv.service` e as unidades de backup com as instaladas. Preserve adaptações necessárias para os caminhos reais. Características mantidas:

- serviço não root, `ProtectSystem=strict`, `ProtectHome=true`, UMask 0077;
- `flock` no mesmo `/run/omnipdv/backend.lock`, uma instância e um worker;
- SQLite gravável no diretório persistente real; chave e instalador somente leitura;
- shutdown SIGTERM aguarda HTTP e worker antes de fechar o banco;
- timer de backup persistente, backup online e sem logs privados.

Não lance um `npm start` paralelo contra o banco real para testar. Valide os arquivos com `systemd-analyze verify` antes de instalá-los. Se for necessário mudar unidades, faça backup e copie somente as unidades revisadas — nunca o ambiente ou arquivos de dados. Execute `daemon-reload` manualmente após revisão.

### Caddy

`ops/Caddyfile` mantém o template `OMNIPDV_DOMAIN`, com padrão **api.omnipdv.com.br**. Se já existe override dessa variável na unidade Caddy, conferir/ajustar manualmente para o hostname da API; não deixar um domínio antigo sobrescrever o padrão. O site raiz continua na hospedagem compartilhada.

Integre o bloco da API ao Caddyfile existente com `sudoedit`; não sobrescreva outros hosts, TLS ou configurações globais. Integre o bloco global de logs ao existente, sem duplicar blocos globais. Não use `root`, `file_server`, CORS wildcard ou cabeçalhos CORS adicionados pelo proxy. O Node é responsável pelo CORS exato somente na criação de Checkout.

Modelo mantido: proxy para `127.0.0.1:3000`, corpo até 1 MiB, headers de segurança, timeout de conexão, sem logs de acesso/erro HTTP com URL privada. Não registrar query strings, cookies, Authorization, corpos do webhook ou tokens de download. Não alterar DNS/firewall nesta tarefa. Se o DNS/TLS ainda não estiver pronto, parar a ativação e resolver por procedimento separado.

Validação futura pelo operador (não executada na VPS nesta tarefa):

```bash
sudo env OMNIPDV_DOMAIN=api.omnipdv.com.br caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Não recarregue um arquivo inválido. Após revisão e em janela autorizada, faça reload do Caddy (não reinstalação).

## 8. Ativação manual e verificações

Anote a release anterior e guarde sua configuração para reversão. Com o banco e chaves preservados, unidades revisadas, backup confirmado e cliente desktop compatível:

1. Pare `omnipdv.service` e aguarde seu encerramento. O shutdown normal drena o worker; em interrupção forçada, os leases/idempotência persistidos permitem nova tentativa segura. Não apague a fila.
2. Troque o symlink de código por rename atômico. Com `DEPLOY_RELEASE` ainda definido para a release aprovada:

   ```bash
   sudo ln -s "$DEPLOY_RELEASE" /opt/omnipdv/current.next && sudo mv -Tf /opt/omnipdv/current.next /opt/omnipdv/current
   ```

   Se `current.next` já existir ou `current` for diretório real, pare e investigue, sem apagar diretórios. Não mover SQLite, ambiente ou chaves junto com o symlink.
3. Inicie o serviço e confira status/logs genéricos. Se a unidade ainda não estava instalada, use a referência Ubuntu para instalar somente as unidades aprovadas e habilitá-las após todas as verificações acima.
4. Verifique localmente:

   ```bash
   curl --fail http://127.0.0.1:3000/healthz
   curl --fail http://127.0.0.1:3000/readyz
   ```

5. Após o Caddy revisado estar ativo, verifique externamente `/healthz` e `/readyz` em **api.omnipdv.com.br**. `/health` é alias de liveness. Readiness confirma banco/worker/shutdown, não faz cobrança nem prova entrega de e-mail.
6. Confira preflight sem criar sessão de pagamento:

   ```bash
   curl -i -X OPTIONS https://api.omnipdv.com.br/api/create-checkout-session \
     -H 'Origin: https://omnipdv.com.br' \
     -H 'Access-Control-Request-Method: POST' \
     -H 'Access-Control-Request-Headers: content-type'
   ```

   Esperado: 204, Allow-Origin exato, POST/Content-Type permitidos e nenhum Allow-Credentials. Origem diferente deve receber 403, sem wildcard. OPTIONS não consome a cota de 60 Checkouts/minuto.
7. Verifique login do navegador e licença no cliente desktop de desenvolvimento usando contas de teste já vinculadas. Não publicar tokens nos logs. Uma consulta sem token deve dar 401, não liberar acesso.
8. Checkout deve retornar ao **site comercial**, não à API. O webhook continua em `https://api.omnipdv.com.br/api/stripe/webhook`. Nenhum endpoint Stripe/Resend foi alterado automaticamente. Se a configuração externa ainda não corresponder, pare e revise pelo procedimento específico — não trocar segredos ou criar destinos live por tentativa.
9. Só executar uma compra manual de teste ou teste de envio após autorização específica e revisão da fila: com Resend ativo, uma assinatura de teste pode causar e-mail real. A suíte automatizada não faz isso.
10. Confirmar timer de backup e integridade do snapshot pós-atualização, sem exportá-lo para área pública.

O CORS afeta somente o browser comercial em Checkout. Passkeys continuam no browser na origem da API; desktop usa Bearer, downloads usam token e Stripe assina o corpo bruto do webhook. Essas rotas não recebem CORS comercial permissivo.

## 9. Reversão sem perda de dados

Se a validação falhar, pare o novo processo e volte somente o symlink para a release anterior aprovada, junto à configuração de origens compatível que foi preservada. Não regenerar chave, não substituir banco por backup antigo e não limpar `events`, `deliveries`, `downloads` ou sessões. Restaurar snapshot antigo sem reconciliar Resend pode perder idempotência e duplicar entrega; recuperação de dados é um procedimento separado.

Não alterar `DEPLOY_ENV=development` ou abrir a porta pública para contornar erro de configuração. Revise permissões, origem, RP ID, leitura da chave e readiness. Não imprima valores privados para diagnosticar. Falhas da Stripe retornam indisponibilidade sem nova autorização offline.

## 10. Compatibilidade do OmniPDV Desktop e das licenças

O protocolo PKCE, Bearer, IDs de conta/sessão/instalação, audience `omnipvd-desktop`, esquema SQLite e assinatura Ed25519 não foram alterados. Reutilize a chave privada atual e o mesmo `kid`. `LICENSE_PREVIOUS_PUBLIC_KEYS_PATH` continua publicando as públicas anteriores durante rotação; rejeita privadas e duplicações.

O desktop deve usar **api.omnipdv.com.br** para login, token, licença e JWKS. Se já usa essa origem, não há mudança de issuer/RP por esta integração. Se ainda usa localhost ou hostname antigo:

- passar para outro RP ID não transfere passkeys automaticamente; planejar recadastro auditado preservando a conta e os vínculos. A fase A não tem recuperação automática para clientes já vinculados;
- a origem AUTH_ORIGIN também é issuer: coordenar a confiança explícita do desktop no issuer novo e, durante transição, preservar confiança necessária em licenças antigas até seu vencimento. Não confiar em issuer/chaves declarados por um token arbitrário;
- não alterar audience, instalação, `kid`, privada ou TTL para tentar compatibilidade. Licenças antigas mantêm seu prazo original, sem renovação pelo cliente;
- cookies browser são host-only e exigem login no host novo; sessões desktop continuam persistidas, mas o aplicativo deve apontar para o endpoint correto;
- não desligar a origem anterior enquanto usuários dependentes não tiverem caminho de migração aprovado. Se houver essa dependência, este é um bloqueio operacional do corte de domínio, não motivo para apagar ou recriar o banco.

## 11. Testes e evidências desta integração

```bash
npm ci
npm run check
npm test
npm run zip:landing
```

A suíte integra os testes de ambas as branches e adiciona regressões para origens separadas em perfil production, CORS com rate limit, readiness do worker, configuração Caddy/systemd e retries Resend mantendo chave/payload idempotentes. Também cobre backup com WAL não checkpointado, rotação pública, persistência de sessão, licenças assinadas, recusa/cancelamento e download privado.

Caddyfile é validado localmente pelo parser (`caddy adapt`), sem iniciar servidor ou ACME; unidades são verificadas por `systemd-analyze verify` sobre cópias temporárias adaptadas ao ambiente de teste, sem instalar/iniciar serviços. A CI faz a mesma classe de validação. Nenhum banco/instalador real, chave privada, credencial ou e-mail real é usado. Artefatos estáticos continuam com seis arquivos públicos e sem pasta extra no ZIP.

Para referências de backup criptografado, recuperação, rotação e instalação nova: [DEPLOY-UBUNTU.md](DEPLOY-UBUNTU.md). Para o site já publicado: [deploy/hostinger-static.md](deploy/hostinger-static.md).
