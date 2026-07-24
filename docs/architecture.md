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

`outbox_events` armazena eventos pendentes e `inbox_receipts` impede
reprocessamento. A implementação do transportador será feita junto com o
edge-agent; o banco já possui a base para retries e idempotência.

## Camadas

```text
src/core          erros compartilhados
src/domain        entidades, papéis e políticas
src/application   casos de uso e contratos
src/infra         Prisma, JWT, bcrypt e licença offline
src/modules       composição NestJS e HTTP
src/shared        guards, filtros e utilitários
```
