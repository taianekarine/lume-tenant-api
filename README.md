# Lume Tenant API

Data plane autônomo da plataforma Lume. Cada cliente executa sua própria
instalação, seu próprio PostgreSQL e seus próprios backups.

## Responsabilidades

- autenticação local;
- usuários internos;
- papéis, departamentos e permissões;
- sessões e refresh tokens;
- auditoria local;
- outbox/inbox para sincronização tolerante a falhas;
- validação offline da licença;
- contrato de comunicação idempotente com o `lume-edge-agent`.
- backend oficial de WhatsApp com Evolution API e n8n;
- conversas, mensagens, solicitações e transições isoladas por tenant;
- inbox/outbox confiáveis, concorrência otimista e retenção configurável.

O projeto não possui master global, operadores da fornecedora ou cadastro de
outros tenants. Uma instalação aceita exatamente um tenant.

O `lume-edge-agent` é mantido em repositório separado e executado na mesma rede
privada do cliente. O contrato de comandos, eventos e assinatura HMAC está em
[`docs/edge-contract.md`](docs/edge-contract.md).

## Inicialização

O `lume-control` entrega:

- `INSTALLATION_ID`;
- `LICENSE_PUBLIC_KEY_BASE64`;
- `LICENSE_DOCUMENT`.

Depois:

```powershell
Copy-Item .env.example .env
npm.cmd install
docker compose up -d
npm.cmd run prisma:deploy
npm.cmd run tenant:bootstrap
npm.cmd run start:dev
```

Preencha no `.env` os dados do tenant e do primeiro administrador antes do
bootstrap. Remova `TENANT_ADMIN_PASSWORD` do ambiente depois da criação.

A API usa `http://localhost:3333/api/v1`. O Swagger local fica em
`http://localhost:3333/docs`.

Para habilitar WhatsApp, preencha o bloco `WHATSAPP_*`, `EVOLUTION_*` e `N8N_*`
do ambiente antes de executar o bootstrap idempotente. O contrato completo,
matriz de estados, assinaturas e endpoints está em
[`docs/whatsapp-mvp.md`](docs/whatsapp-mvp.md).

## Autonomia

Login, usuários, permissões, banco, licença e integrações locais não consultam
o `lume-control`. A queda do computador da fornecedora não interrompe o
cliente.

A licença assinada possui validade e tolerância locais. O endpoint
`GET /api/v1/license/status` mostra o estado sem realizar chamadas externas.

## Dados

Os dados permanecem no PostgreSQL do cliente. O banco deve receber backup,
monitoramento e política de retenção próprios. Sessões não devem ser exportadas
em uma migração para outro fornecedor.

## Qualidade

```powershell
npm.cmd run prisma:validate
npm.cmd run prisma:generate
npm.cmd run format:check
npm.cmd run lint
npm.cmd run test:cov
npm.cmd run build
npm.cmd run prisma:deploy
npm.cmd run test:e2e
docker build --target production -t lume-tenant-api:local .
```

Consulte [architecture.md](docs/architecture.md),
[production.md](docs/production.md), [offboarding.md](docs/offboarding.md),
[edge-contract.md](docs/edge-contract.md) e
[whatsapp-mvp.md](docs/whatsapp-mvp.md).
