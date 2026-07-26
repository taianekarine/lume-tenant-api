# Produção por tenant

Cada cliente recebe uma implantação independente.

## Requisitos da VPS

- Docker e Docker Compose;
- volume persistente do PostgreSQL;
- proxy HTTPS;
- backup automatizado e teste de restauração;
- monitoramento dos probes;
- espaço para fila local durante falhas de internet;
- acesso administrativo restrito.

## Publicação

```powershell
docker compose --env-file C:\segredos\lume-tenant.env `
  -f compose.prod.yml up -d --build
```

Depois da migração, sincronize o bootstrap idempotente:

```powershell
docker compose --env-file C:\segredos\lume-tenant.env `
  -f compose.prod.yml run --rm api npm run tenant:bootstrap:prod
```

Preencha as variáveis `TENANT_*`, `WHATSAPP_*`, `EVOLUTION_*` e `N8N_*`. A
instalação recusa outro tenant, mas o mesmo comando pode ser repetido para
sincronizar papéis, departamento, provider, canal e identidade n8n. Depois do
primeiro acesso, remova `TENANT_ADMIN_PASSWORD`; uma execução posterior não
redefine a senha.

Configure na Evolution:

```text
URL: POST https://api.cliente.example/api/v1/webhooks/evolution/<WHATSAPP_CHANNEL_ID>
Header estático:
x-evolution-webhook-token: <EVOLUTION_WEBHOOK_SECRET>
Eventos: MESSAGES_UPSERT
```

O modo HMAC permanece disponível somente quando existir um proxy capaz de
gerar `x-evolution-timestamp` e assinar o raw body. A configuração nativa usa
o header estático suportado pela Evolution.

Configure o n8n para receber a outbox com `N8N_OUTBOUND_SECRET` e para chamar
endpoints internos usando
`<N8N_SERVICE_KEY_ID>.<N8N_SERVICE_SECRET>`.
O ingresso oficial deve responder exatamente HTTP 202 para confirmar que
assumiu a execução daquele evento. Isso não libera o próximo evento da mesma
conversa: a Tenant API mantém ordem estrita até receber o completion. Toda saída
terminal do workflow deve chamar
`/api/v1/internal/whatsapp/outbox-events/{eventId}/completions`, ecoando o
`executionId`: use `succeeded`, `retryable-failure` ou `terminal-failure`. Sem
callback, o lease vence e o mesmo evento é redistribuído.

Não anuncie batching/debounce entre mensagens da mesma conversa no MVP. Durante
atendimento humano, cada inbound é persistido individualmente no PostgreSQL e
fica disponível no histórico/unread do Tenant Web antes de qualquer execução do
n8n. Redis e n8n não são fonte de verdade dessa captura. Mantenha um único
webhook oficial ativo.

`N8N_WEBHOOK_URL` deve apontar para o webhook oficial
`https://<host-n8n>/webhook/internal/lume-tenant-api/whatsapp-events-v1` e usar
HTTPS. HTTP só é aceito em produção quando
`N8N_ALLOW_INSECURE_PRIVATE_URL=true` e o hostname é privado; use essa exceção
apenas em uma rede interna isolada. Configure
`WHATSAPP_FOLLOW_UP_INACTIVITY_MS` e `EVOLUTION_DISPATCH_LEASE_MS` de forma
idêntica em todas as réplicas.

## Disponibilidade

A indisponibilidade do control não entra nos probes. O readiness verifica:

- processo;
- PostgreSQL local;
- licença local dentro da validade ou tolerância.

Quando a internet externa cair, operações que dependem apenas do banco e da
rede interna continuam. Integrações externas devem usar a outbox e retentativas.

O readiness também informa contagens de outbox pendente/dead sem expor dados de
clientes.

## Atualizações

- use tags versionadas;
- faça backup antes de migrações;
- execute `prisma migrate deploy`;
- mantenha imagem anterior para rollback;
- nunca dependa da tag `latest`;
- atualize um cliente por vez.

## Sequência de pré-deploy

Execute em ordem e sem paralelizar geração Prisma:

```powershell
npm.cmd ci
npm.cmd run prisma:validate
npm.cmd run prisma:generate
npm.cmd run format:check
npm.cmd run lint
npm.cmd run test:cov
npm.cmd run build
npm.cmd run prisma:deploy
npm.cmd run test:e2e
docker build --target production -t lume-tenant-api:2026-07-27 .
```

`DATABASE_URL` aponta para o banco de destino de `prisma:deploy`.
`TEST_DATABASE_URL` deve ser outro banco descartável com `test` no nome; o E2E
o recria. Só então execute o comando de publicação descrito acima.
