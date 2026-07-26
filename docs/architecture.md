# Arquitetura do Lume Tenant API

## Instância única por cliente

```text
VPS do cliente
├── lume-tenant-api
├── PostgreSQL local
├── edge-agent
├── proxy HTTPS
└── backups
```

O banco possui uma única linha em `companies`. O identificador dessa linha é o
`tenantId` contido na licença assinada. O bootstrap rejeita uma segunda
empresa.

## Segurança

- tokens JWT são assinados localmente;
- refresh tokens são opacos e rotacionados;
- senhas usam bcrypt;
- permissões são recalculadas no banco a cada request autenticada;
- o `companyId` do JWT precisa corresponder ao tenant da licença;
- não existem segredos nem tokens do control;
- a chave de licença instalada é pública.

## Continuidade

O runtime não chama o control. A licença é validada com Ed25519 localmente.
Depois do vencimento existe um período de tolerância definido no documento.

Para WhatsApp, `integration_outbox` armazena eventos por tenant e possui
dispatcher n8n com lock, correlação, retry e backoff. `integration_inbox`
deduplica webhooks Evolution e comandos internos. `outbox_events` e
`inbox_receipts` permanecem apenas para compatibilidade com o contrato legado
do edge-agent.

## Camadas

```text
src/core          erros compartilhados
src/domain        entidades, papéis e políticas
src/application   casos de uso e contratos
src/infra         Prisma, JWT, bcrypt e licença offline
src/modules       composição NestJS e HTTP
src/shared        guards, filtros e utilitários
```

O módulo WhatsApp mantém a matriz pura em `src/domain/whatsapp`, casos de uso e
portas em `src/application`, transações Prisma e integrações em `src/infra` e
controllers/DTOs em `src/modules/whatsapp`.
