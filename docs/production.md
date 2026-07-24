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

Depois da primeira migração:

```powershell
docker compose --env-file C:\segredos\lume-tenant.env `
  -f compose.prod.yml run --rm api npm run tenant:bootstrap:prod
```

Preencha temporariamente as variáveis `TENANT_*` do arquivo de ambiente. O
bootstrap é executado uma única vez e a aplicação recusa um segundo tenant.
Depois do primeiro acesso, remova `TENANT_ADMIN_PASSWORD` do arquivo.

## Disponibilidade

A indisponibilidade do control não entra nos probes. O readiness verifica:

- processo;
- PostgreSQL local;
- licença local dentro da validade ou tolerância.

Quando a internet externa cair, operações que dependem apenas do banco e da
rede interna continuam. Integrações externas devem usar a outbox e retentativas.

## Atualizações

- use tags versionadas;
- faça backup antes de migrações;
- execute `prisma migrate deploy`;
- mantenha imagem anterior para rollback;
- nunca dependa da tag `latest`;
- atualize um cliente por vez.
