# Dependências e decisões antes da implementação

## Escopo escolhido

A primeira implementação usa Node.js 24, SQLite (`node:sqlite`) em disco persistente e uma única instância do servidor com um worker local. Não depende de um banco/armazenamento externo ainda não escolhido. O Checkout existente será preservado. E-mail automático permanece desligado por padrão e eventos live não serão processados nesta etapa.

## Decisões necessárias na hospedagem

1. Confirmar que o plano Hostinger executa Node.js 24 com processo contínuo, endpoint HTTPS público e volume persistente gravável. Hospedagem somente estática ou disco efêmero não é suficiente.
2. Reservar diretório privado fora do checkout para SQLite e instalador. Fazer backups do banco (incluindo WAL por procedimento SQLite), limitar permissões e não colocá-lo no Git. Em múltiplas réplicas, migrar a fila/locks para banco compartilhado antes de escalar.
3. Fornecer o `.exe` real no caminho privado. Esta etapa não gera, publica ou hospeda um instalador fictício. Em alternativa, escolher futuramente armazenamento privado S3 compatível e adaptar o serviço.
4. Configurar domínio HTTPS, remetente verificado no Resend, suporte e segredos por variáveis seguras. Não há credenciais no código.
5. Links são credenciais bearer temporárias vinculadas no banco ao cliente e à assinatura. A cada download a autorização atual é verificada na Stripe e no banco. Não comprovam identidade da pessoa que recebeu o link; para exigir identidade, adicionar login/OTP antes da entrega. Não compartilhar links. Configure proxy sem registrar query strings.

## Persistência e entrega

Eventos confirmados por assinatura são aplicados com uma transação SQLite e identificador único. O estado da assinatura é consultado novamente na Stripe para evitar reativação por eventos antigos. A fila de boas-vindas tem uma entrada por assinatura, somente para primeira fatura efetivamente paga. Renovações atualizam autorização; falhas/cancelamentos revogam acesso conforme o estado atual.

O worker persiste payload e chave de idempotência antes do envio. Resend recebe a mesma chave e payload em todas as tentativas. Após 23 horas desde a primeira tentativa ou oito tentativas, uma entrega incerta exige revisão manual, sem reenvio automático: a janela de idempotência do Resend é de 24 horas. Não há promessa de entrega exatamente uma vez fora dessa janela. URLs duram 48 horas para cobrir a janela de retries, sem renovação automática de payload já tentado.

A API de download transmite arquivo privado local, não expõe diretórios e não usa URL pública fixa. O envio é bloqueado se o serviço real de download, as credenciais, a assinatura autorizada ou os dados do cliente não estiverem disponíveis. Nenhuma migração de produção, cobrança real ou envio real faz parte desta implementação.
