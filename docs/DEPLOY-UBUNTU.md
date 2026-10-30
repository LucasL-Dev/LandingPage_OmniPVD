# OmniPDV backend — Ubuntu 24.04 LTS / Node.js 24

Este guia prepara uma **única instância** contínua em VPS, com Caddy, systemd, SQLite WAL privado e worker no mesmo processo. Os comandos são instruções para execução futura pelo operador: nenhuma VPS, DNS, conta Stripe ou envio Resend foi alterado nesta entrega. A branch é `feat/ubuntu-vps-deployment`, derivada de `feat/subscription-licensing`.

**Produção de infraestrutura não significa cobrança live.** O runtime recusa chaves que não sejam `sk_test_...`; os webhooks continuam rejeitando eventos live. Use somente Sandbox/ambiente de teste na Stripe. Não troque para chave live para testar deploy.

## 1. Definir domínio e armazenamento

Exemplos abaixo: `pdv.example.com` e porta interna 3000. Substitua por domínio que você controla. Crie registro A (e AAAA somente se IPv6 estiver funcional) apontando para a VPS. Libere TCP 80/443 na VPS e no firewall Hostinger; nunca exponha a porta 3000. Se houver proxy/CDN, valide TLS e origens; inicialmente use DNS direto.

Escolha um hostname estável para página, `/account/login`, API e downloads. `DOMAIN=AUTH_ORIGIN=DOWNLOAD_ORIGIN=https://SEU_HOST`, `AUTH_RP_ID=SEU_HOST`. Não renomeie depois de cadastrar passkeys. **Uma passkey de localhost não autentica automaticamente no domínio público.** Use o procedimento de convite e vinculação verificada já documentado em `licensing/README.md` para cadastrar passkeys no novo RP; preserve as contas/dados existentes, sem redefinir vínculos informalmente.

Diretórios:

| Caminho | Uso / acesso |
| --- | --- |
| `/opt/omnipdv/releases/REVISAO` | Código e dependências versionados; root escreve, serviço lê |
| `/opt/omnipdv/current` | Symlink para release ativa |
| `/etc/omnipdv/backend.env` | Ambiente privado, root:root 0600; systemd injeta no processo |
| `/var/lib/omnipdv/billing.sqlite` | Banco persistente privado e seus WAL/SHM; usuário omnipdv |
| `/var/lib/omnipdv/backups` | Snapshots privados consistentes, não públicos |
| `/srv/omnipdv-private` | Chave Ed25519 e instalador, fora do checkout; root escreve, serviço lê |
| `/run/omnipdv/backend.lock` | Lock flock do processo único, liberado pelo kernel em falhas |

Não use SQLite em NFS/SMB, filesystem efêmero ou múltiplas réplicas. Disco persistente local da VPS deve ter espaço monitorado. Não rode PM2/cluster, segundo worker ou um `npm start` paralelo ao serviço.

## 2. Instalar dependências do sistema

Em Ubuntu 24.04, com operador sudo:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git caddy sqlite3 age
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/nodesource.asc
gpg --dearmor --output /tmp/nodesource.gpg /tmp/nodesource.asc
sudo install -m 0644 /tmp/nodesource.gpg /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
sudo apt-get update
sudo apt-get install -y nodejs
/usr/bin/node --version
npm --version
```

Confira que `/usr/bin/node` é **24.x**. A origem NodeSource é um repositório externo assinado; siga a política de confiança do seu ambiente e mantenha atualizações de segurança do Node 24. O serviço usa esse caminho, não um `nvm` de usuário.

```bash
sudo adduser --system --group --home /var/lib/omnipdv --no-create-home omnipdv
sudo install -d -o root -g root -m 0755 /opt/omnipdv/releases
sudo install -d -o root -g root -m 0700 /etc/omnipdv
sudo install -d -o omnipdv -g omnipdv -m 0700 /var/lib/omnipdv /var/lib/omnipdv/backups
sudo install -d -o root -g omnipdv -m 0750 /srv/omnipdv-private
```

Se usuário/diretórios já existem, confira-os e pule sua criação; **não apague nada**. Verifique que `/var/lib/omnipdv` está no volume persistente esperado: `findmnt -T /var/lib/omnipdv` e `df -h /var/lib/omnipdv`. Não formate ou monte por cima de dados existentes. Configure alertas de espaço e inodes.

## 3. Preparar release de código

Como operador sem privilégios, clone/revise a branch; não execute npm como root:

```bash
git clone --branch feat/ubuntu-vps-deployment https://github.com/LucasL-Dev/LandingPage_OmniPVD.git ~/omnipdv-src
cd ~/omnipdv-src
npm ci
npm run check
npm test
REVISION=$(git rev-parse HEAD)
sudo install -d -m 0755 "/opt/omnipdv/releases/$REVISION"
sudo cp -a . "/opt/omnipdv/releases/$REVISION/"
sudo chown -R root:root "/opt/omnipdv/releases/$REVISION"
```

Não tenha `.env`, banco, instalador ou chave nesse checkout. O `cp` inclui somente o checkout revisado e `node_modules`; confirme antes com `git status --short` e inspecione arquivos ignorados sem imprimir seu conteúdo. Em deploy recorrente, reutilize o clone e selecione uma revisão aprovada. Nunca dê `git pull` dentro da release ativa.

Na primeira instalação, **se `/opt/omnipdv/current` ainda não existir**:

```bash
sudo ln -s "/opt/omnipdv/releases/$REVISION" /opt/omnipdv/current
```

Se já existir, use o procedimento de atualização abaixo.

## 4. Chave, instalador e ambiente privado

Se já existe chave válida para esse ambiente, preserve-a e configure seu caminho. **Não gere outra chave ao atualizar código.** Para um ambiente novo, gere com exclusividade, fora do checkout:

```bash
sudo /usr/bin/node /opt/omnipdv/current/licensing/keygen.mjs /srv/omnipdv-private/license-2026-01.pem
sudo chown root:omnipdv /srv/omnipdv-private/license-2026-01.pem
sudo chmod 0640 /srv/omnipdv-private/license-2026-01.pem
```

O comando não sobrescreve arquivo existente e imprime apenas a chave pública. Não copie a privada para Git, `.env`, navegador ou aplicativo Electron. Faça backup criptografado dela conforme seção 9.

Transfira seu instalador aprovado para uma área privada da VPS por canal seguro. Confira hash/origem, depois instale sem torná-lo público:

```bash
sudo install -o root -g omnipdv -m 0640 /CAMINHO/PRIVADO/INSTALADOR-APROVADO.exe /srv/omnipdv-private/OmniPDV-Setup.exe
sudo install -o root -g root -m 0600 /opt/omnipdv/current/ops/backend.env.example /etc/omnipdv/backend.env
sudoedit /etc/omnipdv/backend.env
```

Não sobrescreva um `backend.env` já configurado: nesse caso, faça cópia privada e revise apenas novas variáveis com `sudoedit`. O arquivo usa sintaxe **EnvironmentFile do systemd**, sem `export` ou expansão de `$VAR`; cite valores com espaços. Não execute `source` e não use `systemctl show ... Environment` ou `printenv` para diagnosticar segredos.

**Variáveis necessárias:**

| Variável | Valor / condição |
| --- | --- |
| `DEPLOY_ENV`, `NODE_ENV` | `production`, `production`; use `staging` na configuração de homologação |
| `HOST`, `PORT` | `127.0.0.1`, `3000` |
| `DOMAIN` | Origem HTTPS pública, sem barra final |
| `STRIPE_SECRET_KEY` | Chave privada `sk_test_...` da Sandbox correta, nunca live |
| `STRIPE_PRICE_ID` | Price recorrente de teste correspondente ao plano |
| `STRIPE_WEBHOOK_SECRET` | Segredo do endpoint público de teste, não o segredo da Stripe CLI local |
| `BILLING_DB_PATH` | `/var/lib/omnipdv/billing.sqlite`, absoluto, fora do checkout |
| `AUTH_ENABLED` | `true` |
| `AUTH_ORIGIN`, `AUTH_RP_ID` | Origem HTTPS igual a DOMAIN e hostname exato |
| `AUTH_ALLOW_LOCALHOST` | `false` |
| `LICENSE_PRIVATE_KEY_PATH`, `LICENSE_SIGNING_KEY_ID` | Arquivo privado existente e identificador público estável |
| `DOWNLOAD_ORIGIN` | Mesma origem HTTPS, mesmo com download inicialmente desligado |
| `PRIVATE_DOWNLOAD_ENABLED` | `false` inicialmente; ativar somente após validar instalador privado real |
| `PRIVATE_INSTALLER_PATH` | `/srv/omnipdv-private/OmniPDV-Setup.exe` |
| `AUTO_WELCOME_EMAIL_ENABLED` | `false` inicialmente; habilitar envio somente em teste controlado aprovado |
| `RESEND_API_KEY`, `RESEND_FROM`, `SUPPORT_EMAIL` | Necessários se worker de e-mail habilitado; remetente/domínio verificados no Resend |
| `AUTH_ACCESS_TTL_SECONDS` | Opcional, padrão 600, limites 60–900 |
| `AUTH_SESSION_TTL_SECONDS` | Opcional, padrão 2592000, limites 3600–2592000 |
| `AUTH_BROWSER_TTL_SECONDS` | Opcional, padrão 43200, limites 300–86400 |
| `LICENSE_OFFLINE_TTL_SECONDS` | Opcional, padrão 14400, limites 60–14400 |
| `LICENSE_RECHECK_SECONDS` | Opcional, padrão 900, limites 30–3600 |
| `LICENSE_PREVIOUS_PUBLIC_KEYS_PATH` | Opcional, JWKS **somente público** para rotação, fora do checkout |
| `QUEUE_INTERVAL_SECONDS` | Opcional, padrão 30, limites 5–300 |
| `MAX_CONCURRENT_DOWNLOADS` | Opcional, padrão 4, limites 1–32 |
| `MAX_INSTALLER_BYTES` | Opcional, padrão 2147483648 (2 GiB), máximo 8 GiB |
| `BACKUP_DIR` | `/var/lib/omnipdv/backups` |

A aplicação hospedada não carrega `.env` do checkout em staging/production. Configuração inválida falha antes de escutar e sem imprimir valores privados. O arquivo de exemplo não contém credenciais reais. Ausência inicial de banco cria o esquema em nova instalação; **para migração de banco existente, pare primeiro o serviço de origem e transfira um backup consistente**, nunca um banco aberto copiando apenas `.sqlite`.

## 5. Instalar e iniciar systemd

```bash
sudo install -m 0644 /opt/omnipdv/current/ops/systemd/omnipdv.service /etc/systemd/system/omnipdv.service
sudo install -m 0644 /opt/omnipdv/current/ops/systemd/omnipdv-backup.service /etc/systemd/system/omnipdv-backup.service
sudo install -m 0644 /opt/omnipdv/current/ops/systemd/omnipdv-backup.timer /etc/systemd/system/omnipdv-backup.timer
sudo systemd-analyze verify /etc/systemd/system/omnipdv.service /etc/systemd/system/omnipdv-backup.service /etc/systemd/system/omnipdv-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now omnipdv.service
curl --fail http://127.0.0.1:3000/healthz
curl --fail http://127.0.0.1:3000/readyz
sudo systemctl status omnipdv.service --no-pager
sudo journalctl -u omnipdv.service -n 30 --no-pager
```

O usuário de serviço não tem login interativo; código/chave/instalador são somente leitura. `flock` impede duas execuções usando o mesmo lock. Utilize sempre a unidade, inclusive para reinícios, e não lance processo independente com outro lock/porta no mesmo banco. A fila inicia somente depois de a porta estar disponível. Uma falha libera o lock e systemd reinicia com limite de tentativas. SIGTERM encerra HTTP/worker e fecha SQLite; após 60s há saída controlada de emergência, e o lease persistido permite reconciliação posterior.

`/healthz` indica processo vivo; `/readyz` verifica acesso ao SQLite, estado do worker e desligamento. Retornam somente `{"status":"ok"}` ou `{"status":"unavailable"}`; não consultam Stripe/Resend, não provam pagamento e não expõem versões, caminhos ou segredos. Configure monitor externo e alertas para 503/reinícios.

## 6. HTTPS com Caddy

Não configure `root` ou `file_server`: isso exporia arquivos que o backend bloqueia. O Caddy só encaminha para loopback.

```bash
sudo install -m 0644 /opt/omnipdv/current/ops/Caddyfile /etc/caddy/Caddyfile
sudo install -d -m 0755 /etc/systemd/system/caddy.service.d
printf '%s\n' '[Service]' 'Environment=OMNIPDV_DOMAIN=pdv.example.com' | sudo tee /etc/systemd/system/caddy.service.d/omnipdv.conf >/dev/null
sudo systemctl daemon-reload
sudo env OMNIPDV_DOMAIN=pdv.example.com caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl restart caddy
curl --fail https://pdv.example.com/healthz
curl --fail https://pdv.example.com/readyz
```

Substitua o hostname nos comandos. A primeira inicialização do Caddy em servidor real obtém certificado automaticamente; exige DNS e 80/443 funcionais. Não use localhost como domínio comercial. Não ative HSTS includeSubDomains/preload sem avaliar todos os subdomínios.

O exemplo não registra access logs e exclui logs de erro HTTP que podem carregar URI completa. **Query strings contêm códigos/tokens**: não habilite logs brutos de URL, cabeçalhos, cookies, corpo, traces/APM ou analytics em autenticação/download. O proxy remove cabeçalhos de IP encaminhado e o backend usa o IP do socket; clientes atrás do proxy compartilham os limites existentes. Não passe a confiar em `X-Forwarded-For` arbitrário para contornar limites. Escala e limitação por cliente real exigem política de proxy adicional, fora desta entrega.

Se usar UFW, antes de habilitar preserve seu acesso administrativo e confira a porta SSH real:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status verbose
```

Habilite somente após conferir regras e console de recuperação; não abra 3000. No painel Hostinger, aplique a mesma restrição. Verifique `ss -ltnp`: Node deve escutar apenas `127.0.0.1:3000`.

## 7. Webhook Stripe e Resend

No Dashboard Stripe, selecione explicitamente a **Sandbox/modo teste** usado pela chave e pelo Price. Crie destino de eventos para:

```text
https://pdv.example.com/api/stripe/webhook
```

Selecione `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.voided`, `invoice.marked_uncollectible`, `customer.subscription.created`, `customer.subscription.updated` e `customer.subscription.deleted`. Copie o segredo desse destino privado para `STRIPE_WEBHOOK_SECRET` com `sudoedit`, reinicie `omnipdv` e use compras/cancelamentos **somente de teste**. Não altere assinaturas reais. O corpo original é verificado por assinatura, limite 1 MiB; erros transitórios respondem 503 para retries e eventos persistidos são idempotentes.

Resend não precisa de um segundo daemon: o worker roda no processo único com fila SQLite, exclusão de ticks sobrepostos e leases. Antes de habilitar, confira domínio/remetente e destinatário de teste autorizado. `AUTO_WELCOME_EMAIL_ENABLED=true` exige também download privado habilitado, remetente, suporte e API key. Isso pode enviar e-mails reais, portanto não habilite por simples cópia de exemplo.

A chave/payload de idempotência existentes são preservados. Após oito tentativas ou 23 horas de resultado incerto, a entrega vai para `manual_review`; não force novo envio ou apague o registro. Diagnóstico usa códigos fixos (`queue_unavailable`, `provider_rate_limited`, `provider_not_confirmed`, `delivery_failed`) sem mensagens privadas dos provedores. Consulte contagens com SQLite read-only, sem selecionar payloads/tokens:

```bash
sudo -u omnipdv sqlite3 -readonly /var/lib/omnipdv/billing.sqlite 'SELECT status,count(*) FROM deliveries GROUP BY status;'
```

## 8. Recursos e verificação de exposição

Node limita cabeçalhos a 16 KiB, corpo webhook a 1 MiB (rotas de autenticação mantêm seu próprio limite), 128 requisições simultâneas, 256 conexões e 60 criações de Checkout por minuto no processo (limite global compartilhado). Há timeouts de HTTP/Stripe e até quatro downloads simultâneos por padrão. O instalador é transmitido por stream e precisa caber no limite de tamanho. A unidade limita memória a 768 MiB e tarefas a 128; ajuste somente com medição da VPS e mantenha monitoramento de disco/backups. A fila e históricos não têm limpeza automática: planeje retenção sem perder idempotência/auditoria.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://pdv.example.com/.env
curl -s -o /dev/null -w '%{http_code}\n' https://pdv.example.com/billing.sqlite
curl -s -o /dev/null -w '%{http_code}\n' https://pdv.example.com/license.pem
curl -s -o /dev/null -w '%{http_code}\n' https://pdv.example.com/OmniPDV-Setup.exe
curl -s -o /dev/null -w '%{http_code}\n' https://pdv.example.com/ops/backend.env.example
curl -s -o /dev/null -w '%{http_code}\n' https://pdv.example.com/api/download
```

Os cinco primeiros devem retornar 404; download sem token válido deve ser negado (403 ou 503 enquanto desligado). O JWKS público é intencional e não contém a chave privada. Não teste links reais contendo tokens em terminais gravados. Downloads permanecem bearer temporários de 48h e revalidam assinatura na Stripe; não são prova de identidade nem substituem login/licença do desktop.

## 9. Backup consistente, chave e cópia externa

```bash
sudo systemctl start omnipdv-backup.service
sudo systemctl status omnipdv-backup.service --no-pager
sudo systemctl enable --now omnipdv-backup.timer
sudo systemctl list-timers omnipdv-backup.timer
```

O timer executa diariamente às 03:15 no fuso do servidor, com atraso aleatório até 15min. Se quiser horário de São Paulo, configure isso explicitamente no timer; não suponha que a VPS já esteja nesse fuso. O script usa a API de backup SQLite, inclui transações confirmadas no WAL, valida `quick_check` e grava arquivo novo 0600. Não copia somente `.sqlite`, não sobrescreve a origem e recusa origem inexistente. Não apaga backups automaticamente; monitore espaço e defina retenção aprovada. Faça backup antes de atualizações e teste restauração em diretório isolado.

Backups do banco contêm dados pessoais, sessões e payloads com links: são privados. Mantenha cópia criptografada fora da VPS e backups separados do `backend.env`, das chaves Ed25519 e do instalador aprovado. Não inclua a identidade privada de descriptografia junto ao backup.

Com um arquivo de destinatários **públicos** age criado pelo responsável pela recuperação e armazenado em `/etc/omnipdv/backup-recipients.txt`:

```bash
sudo install -d -m 0700 /var/backups/omnipdv-encrypted
sudo tar -C / -cf - etc/omnipdv/backend.env srv/omnipdv-private | sudo age -R /etc/omnipdv/backup-recipients.txt -o /var/backups/omnipdv-encrypted/private-material-REVISAO.tar.age
sudo age -R /etc/omnipdv/backup-recipients.txt -o /var/backups/omnipdv-encrypted/billing-REVISAO.sqlite.age /var/lib/omnipdv/backups/BACKUP-ESCOLHIDO.sqlite
```

Use nomes exclusivos, substitua os exemplos, restrinja permissões dos arquivos criptografados e transfira-os para armazenamento externo privado aprovado. Nenhum destino externo é configurado automaticamente. A criptografia não dispensa retenção, integridade, teste de recuperação e controle de acesso.

## 10. Atualizar e fazer rollback do código

Prepare nova revisão em `~/omnipdv-src`, execute `npm ci`, `npm run check`, `npm test` e copie-a para **nova** pasta em `/opt/omnipdv/releases` como na seção 3. Não modifique o ambiente privado ao copiar código.

```bash
sudo systemctl start omnipdv-backup.service
PREVIOUS=$(readlink -f /opt/omnipdv/current)
sudo systemctl stop omnipdv.service
sudo ln -s "/opt/omnipdv/releases/$REVISION" /opt/omnipdv/current-next
sudo mv -Tf /opt/omnipdv/current-next /opt/omnipdv/current
sudo systemctl start omnipdv.service
curl --fail http://127.0.0.1:3000/readyz
```

Registre `PREVIOUS` no controle de implantação. Os nomes temporários precisam estar livres; não reutilize sobrescrevendo diretórios. Caso a nova versão falhe, pare o serviço e volte o symlink para `PREVIOUS` com a mesma troca atômica, depois inicie e verifique readiness. **Rollback de código não restaura banco antigo automaticamente.** Confira compatibilidade do esquema antes de voltar versão; as migrações de contas atuais são aditivas. Reconciliar entregas evita reenvios indevidos.

## 11. Restaurar banco — procedimento excepcional

Antes, teste o backup em pasta isolada com `sqlite3 -readonly CAMINHO 'PRAGMA quick_check;'`. Para recuperação real, tenha aprovação operacional e reconcilie eventos Stripe e mensagens Resend posteriores ao snapshot. Restaurar estado antigo pode ressuscitar sessões revogadas e entregas já enviadas. Revogue sessões afetadas pelo procedimento administrativo auditado do backend e reconcilie filas antes de reabilitar envios/downloads.

Pare o backend e preserve o estado atual **sem excluir arquivos**:

```bash
sudo systemctl stop omnipdv.service
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -o omnipdv -g omnipdv -m 0700 "/var/lib/omnipdv/quarantine-$STAMP"
for SUFFIX in '' '-wal' '-shm'; do
  if sudo test -e "/var/lib/omnipdv/billing.sqlite$SUFFIX"; then
    sudo mv "/var/lib/omnipdv/billing.sqlite$SUFFIX" "/var/lib/omnipdv/quarantine-$STAMP/"
  fi
done
sudo install -o omnipdv -g omnipdv -m 0600 /CAMINHO/PRIVADO/BACKUP-VALIDADO.sqlite /var/lib/omnipdv/billing.sqlite
sudo -u omnipdv sqlite3 -readonly /var/lib/omnipdv/billing.sqlite 'PRAGMA quick_check;'
```

Não inicie antes da revisão/reconciliação descrita. Deixe e-mail/download desligados no ambiente durante a análise. Então inicie `omnipdv` e valide health, contas e idempotência. Nunca reutilize WAL/SHM de outro snapshot, nunca apague tabelas nem faça `DROP`/reset para corrigir erro de deploy.

## 12. Rotação Ed25519 sem invalidar licenças offline existentes

1. Faça backup criptografado da chave atual e do ambiente. Mantenha hostname/issuer/RP ID estáveis.
2. Exporte **apenas a pública atual**, com o `kid` atual, para o JWKS de transição:

   ```bash
   sudo /usr/bin/node /opt/omnipdv/current/scripts/license-public.mjs /srv/omnipdv-private/license-2026-01.pem phase-a-1 | sudo tee /srv/omnipdv-private/previous-public-keys.json >/dev/null
   sudo chown root:omnipdv /srv/omnipdv-private/previous-public-keys.json
   sudo chmod 0640 /srv/omnipdv-private/previous-public-keys.json
   ```

3. Gere nova privada com `license:keygen` para **outro caminho**, com outro `LICENSE_SIGNING_KEY_ID` único. Ajuste owner/mode como na seção 4. Não sobrescreva a chave anterior.
4. Configure `LICENSE_PREVIOUS_PUBLIC_KEYS_PATH=/srv/omnipdv-private/previous-public-keys.json`, a nova privada e o novo kid com `sudoedit`. O runtime rejeita chaves privadas, curvas erradas, kids duplicados e mais de dez públicas anteriores.
5. Reinicie, confira JWKS público contendo nova+antiga e valide um login/licença de teste. Licenças novas usam a nova privada; as antigas continuam verificáveis até seu prazo original.
6. Mantenha públicas antigas pelo menos até todas as autorizações emitidas com elas expirarem (TTL máximo quatro horas, margem de relógio/implantação). Clientes com chaves embutidas precisam recebê-las antes da troca; o desktop integrado busca JWKS somente da origem HTTPS confiável.
7. Depois da janela e da verificação operacional, retire a pública antiga do conjunto de transição. Guarde a privada anterior criptografada conforme política; não a publique ou remova automaticamente. Chave comprometida exige procedimento de incidente e reconexão; não há revogação instantânea de clientes offline.

## 13. Separação de staging

Use domínio, diretórios, DB, chaves, configuração, credenciais de teste e lock independentes. Preferencialmente outra VPS. Se compartilhar máquina, crie outro usuário/unidades, porta loopback e paths distintos; adapte todas as diretivas do serviço/Caddy, sem compartilhar `BILLING_DB_PATH`. Uma conta/passkey de staging não é prova de autorização em produção. Não copie segredos/bancos de produção para testes automatizados.

## 14. Testes e CI

`npm ci && npm run check && npm test` roda sem credenciais reais, com bancos/instalador sintéticos temporários. Cobre regressões de Checkout, webhook, fila Resend, download, contas/passkeys, PKCE e licenciamento, além de configuração VPS, health sem vazamento, backup com WAL, rotação pública, worker serializado, limite de tamanho/conexões de download e bloqueio de live.

A CI Ubuntu usa Node 24, valida sintaxe, testes, Caddy e unidades systemd sem iniciar serviço, DNS, HTTPS público ou enviar mensagens. Nenhum deploy, banco real, release, segredo ou instalador é publicado. A validação real de DNS/TLS, remetente Resend e recebimento do webhook na VPS é uma etapa futura assistida pelo operador.
