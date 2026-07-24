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
- futura comunicação com o edge-agent.

O projeto não possui master global, operadores da fornecedora ou cadastro de
outros tenants. Uma instalação aceita exatamente um tenant.

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
npm.cmd run format:check
npm.cmd run prisma:validate
npm.cmd run lint
npm.cmd run test:cov
npm.cmd run build
```

Consulte [architecture.md](docs/architecture.md),
[production.md](docs/production.md), [offboarding.md](docs/offboarding.md) e
[edge-contract.md](docs/edge-contract.md).
