# Integração Windows — login OTP e licenciamento

## Inspeção do Electron

Foi inspecionado, somente para leitura, `LucasL-Dev/PDV_Sistem` no commit `5c6e1c2106231f210e99ca688323a3607c96dc8d`. Em `electron/main.mjs` há janela/contexto confiável, IPC e uso de `safeStorage` para credenciais locais (por exemplo, Mercado Pago). Não foi encontrada implementação do cliente remoto `/api/auth/authorize`, PKCE ou `/api/license/status` nessa revisão. O login local de operadores da loja é uma identidade diferente da conta comercial OmniPDV.

Portanto, esta branch entrega o backend/protocolo e a página de login, mas **não faz o executável atual ativar sozinho sem a futura integração do cliente**. Nenhum arquivo do repositório Electron foi alterado. A validação desktop descrita nos testes é um cliente de teste do protocolo existente do backend.

## Contrato que o processo principal deverá implementar

Origem única confiável: `https://api.omnipdv.com.br`. Site comercial: `https://omnipdv.com.br`. Não enviar códigos por IPC genérico nem armazenar tokens no renderer/localStorage. Preferir o navegador padrão do sistema; a página da API cuida do OTP com seus cookies, origem e CSRF. Não criar BrowserWindow insegura ou desligar validação TLS.

1. Criar/reutilizar `installation_id` opaco aleatório base64url (16–128 caracteres) e protegê-lo no perfil local. Não usar e-mail ou impressão digital invasiva do hardware.
2. Antes de abrir o navegador, iniciar servidor temporário em `127.0.0.1`, porta aleatória disponível maior ou igual a 1024, rota **exata** `/omnipvd/callback`. Não escutar em `0.0.0.0`. Definir timeout e aceitar somente o primeiro callback válido.
3. Gerar `state` aleatório de 32 bytes (base64url de 43 caracteres) e `code_verifier` criptograficamente aleatório de 43–128 caracteres URL-safe. Guardar ambos só na memória do processo principal; `code_challenge=base64url(SHA256(code_verifier))`.
4. Abrir com `shell.openExternal` a URL montada por `URL`/`URLSearchParams`:

   ```text
   https://api.omnipdv.com.br/api/auth/authorize
     ?client_id=omnipvd-desktop
     &response_type=code
     &redirect_uri=http%3A%2F%2F127.0.0.1%3APORTA%2Fomnipvd%2Fcallback
     &code_challenge_method=S256
     &code_challenge=DESAFIO_ALEATORIO_DA_TENTATIVA
     &state=ESTADO_ALEATORIO_DA_TENTATIVA
     &installation_id=ID_LOCAL_DA_INSTALACAO
     &device_name=NOME_AMIGAVEL
   ```

   As maiúsculas acima são campos explicativos, não valores de produção. Não incluir e-mail, OTP, bearer ou refresh na URL. O callback é HTTP apenas no loopback; todos os acessos remotos usam HTTPS.

5. O comprador informa o e-mail da compra no navegador e recebe código de seis dígitos pelo Resend. O primeiro acesso elegível cria a conta sem senha, convite administrativo ou passkey. Contas antigas precisam da adesão explícita descrita em [EMAIL-OTP.md](../auth/EMAIL-OTP.md), ou continuam com passkey. Depois de autenticado, o usuário **confirma** o dispositivo; não autoaprovar consentimento.
6. Receber no loopback apenas `code` e `state`. Conferir caminho, método GET, unicidade dos parâmetros, `state` exato da tentativa e timeout antes de aceitar. Não carregar recursos remotos nessa página nem registrar query strings. Encerrar o listener depois da confirmação válida/timeout; invalidar estado/verifier ao cancelar.
7. Fazer do processo principal:

   ```http
   POST /api/auth/token
   Content-Type: application/json
   ```

   ```json
   {
     "client_id": "omnipvd-desktop",
     "grant_type": "authorization_code",
     "code": "CODIGO_RECEBIDO_NO_LOOPBACK",
     "code_verifier": "VERIFICADOR_LOCAL_DA_MESMA_TENTATIVA",
     "redirect_uri": "http://127.0.0.1:PORTA/omnipvd/callback"
   }
   ```

   A URI precisa ser idêntica à autorização. O código expira em 60 segundos e é de uso único; não é o OTP do e-mail. Cliente nativo omite `Origin` nessa troca, sem simular origem browser. A resposta JSON tem `access_token`, `refresh_token`, `token_type`, `account_id`, `session_id`, `installation_id`, `expires_in` e `session_expires_at`. Tokens nunca são enviados na URL.

8. Guardar refresh/session e metadados com `safeStorage`/DPAPI e escrita atômica restrita no processo principal; recusar armazenamento sem criptografia. Access token preferencialmente apenas em memória. Não reutilizar o arquivo de credenciais do Mercado Pago nem exportar segredos ao renderer.
9. Consultar:

   ```http
   GET /api/license/status
   Authorization: Bearer ACCESS_TOKEN
   ```

   Sem e-mail, `customer_id` ou assinatura como parâmetros. Resposta: `authorized`, `subscription_status`, `authorization_expires_at`, `next_check_at` e `offline_authorization`. Só liberar o produto quando `authorized=true` e respeitar os prazos. Pagamento pendente/recusado, cancelamento, expiração e inadimplência não liberam a licença. Login bem-sucedido não autoriza, por si só, o uso do aplicativo.
10. Renovar usando `POST /api/auth/token` com `{client_id:"omnipvd-desktop",grant_type:"refresh_token",refresh_token}`. Substituir o refresh anterior de forma atômica. Serializar renovações: reutilização revoga a família. Se perder a resposta de uma rotação, exigir novo login em vez de repetir indefinidamente o token anterior.
11. Logout nativo: `POST /api/auth/logout`, JSON `{}`, Bearer atual; depois apagar os tokens/lease locais. Sessões podem ser listadas com GET `/api/auth/sessions`. Revogação seletiva é realizada no navegador autenticado, com CSRF, em `/account/login`.

## Licença offline e erros

Validar `offline_authorization` com chave pública Ed25519 confiável/pinada, algoritmo/typ esperados, issuer `https://api.omnipdv.com.br`, audience `omnipvd-desktop`, `sub`, `sid`, `installation_id`, `iat`, `nbf` e `exp`. Referência: `licensing/service.mjs::verifyOfflineLicense` e [licensing/README.md](../licensing/README.md). JWKS público em `/.well-known/omnipvd-license-keys.json`; não confiar cegamente numa chave recebida de URL arbitrária. Não colocar chave privada no aplicativo, ampliar validade ou tratar mudança de relógio como extensão da licença.

HTTP 401: sessão inválida/expirada/revogada → novo login. 429: respeitar Retry-After e backoff. 503: indisponibilidade temporária → não inventar autorização; usar somente lease offline previamente validado ainda no prazo. `authorized=false`: bloquear funções licenciadas e orientar regularização, sem excluir dados locais da loja. Expirado o lease, interromper uso licenciado até validação online. A chave Ed25519 atual e o formato da licença permanecem inalterados.

Não incluir Stripe/Resend/webhook/admin secrets no Electron. Não ativar pagamentos reais para testar. Usar backend e Stripe Sandbox controlados; uma credencial Resend real ainda envia e-mail real, portanto a suíte desta branch usa transporte simulado.
