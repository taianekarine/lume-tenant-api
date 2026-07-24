# Contrato futuro do edge-agent

O edge-agent será um terceiro projeto. Ele não faz parte desta entrega.

## Responsabilidade

- chamar APIs acessíveis somente dentro da rede do cliente;
- armazenar credenciais do Gestor, ERP ou outros sistemas locais;
- receber comandos do tenant-api;
- devolver resultados normalizados;
- executar retries e idempotência;
- continuar processando quando o control estiver indisponível.

## Limites

O edge não é fonte oficial de:

- usuários;
- papéis;
- permissões;
- sessões;
- auditoria de negócio.

Esses dados pertencem ao `lume-tenant-api`.

## Comunicação proposta

```text
lume-tenant-api
    ↓ comando com commandId
edge-agent
    ↓ rede interna
API Gestor
    ↑ resultado
edge-agent
    ↑ evento com eventId
lume-tenant-api
```

Comandos e eventos devem ser idempotentes. Nenhum adapter recebe acesso direto
ao PostgreSQL; a comunicação ocorre por contrato HTTP ou fila local
autenticada.
