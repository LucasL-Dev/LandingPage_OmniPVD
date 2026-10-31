# Backend na VPS — guia consolidado com Caddy

A infraestrutura existente usa **Caddy**, não Nginx. O guia definitivo desta integração é [DEPLOY-PRODUCTION-INTEGRATION.md](../DEPLOY-PRODUCTION-INTEGRATION.md).

Ele reúne as duas branches, reutiliza `~/omnipdv-src`, preserva systemd, worker, backup SQLite e chaves, e mantém `https://omnipdv.com.br` separado de `https://api.omnipdv.com.br`.

A referência operacional completa de instalação nova, backups, recuperação e rotação está em [DEPLOY-UBUNTU.md](../DEPLOY-UBUNTU.md). A publicação estática continua em [hostinger-static.md](hostinger-static.md).

Nenhum deploy, merge na main, mudança de DNS, Stripe, Resend ou Hostinger foi executado. Não substituir arquivos privados pela configuração de exemplo.
