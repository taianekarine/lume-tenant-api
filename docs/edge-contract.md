# Contrato do lume-edge-agent

O `lume-edge-agent` é um terceiro projeto independente. Ele roda na rede
privada do cliente e acessa APIs que não estão disponíveis publicamente, como a
API Gestor da Milenium.

## Responsabilidade

- receber comandos técnicos do tenant;
- manter fila PostgreSQL local;
- executar somente operações permitidas no adapter;
- aplicar idempotência, timeout, retries e dead-letter;
- devolver resultados normalizados como eventos;
- continuar processando quando o control estiver indisponível.

O edge não é fonte oficial de usuários, departamentos, permissões, sessões ou
auditoria de negócio. Esses dados pertencem ao `lume-tenant-api`.

## Fluxo

```text
lume-tenant-api
    ↓ POST /api/v1/edge/commands
lume-edge-agent
    ↓ rede interna
API Gestor
    ↑ resultado
lume-edge-agent
    ↑ POST /api/v1/integrations/edge/events
lume-tenant-api
```

## Identidade e assinatura

Cada instalação recebe:

- `tenantId`;
- `installationId`;
- segredo HMAC exclusivo.

Comandos e eventos usam os headers:

- `x-lume-installation-id`;
- `x-lume-timestamp`;
- `x-lume-signature`.

A assinatura é o HMAC-SHA256 hexadecimal de
`<timestamp>.<corpo HTTP bruto>`. `commandId` e `eventId` garantem
idempotência.

## Estado atual da integração

O edge-agent já implementa recebimento, execução Gestor, fila e publicação de
eventos. O tenant já possui as tabelas `outbox_events` e `inbox_receipts`.

O transportador da outbox e o endpoint
`POST /api/v1/integrations/edge/events` ainda devem ser adicionados ao tenant
antes da ativação ponta a ponta. Essa implementação será um módulo do tenant e
não dará ao edge acesso direto ao PostgreSQL.
