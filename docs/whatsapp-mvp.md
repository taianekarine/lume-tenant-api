# Backend WhatsApp MVP

Este módulo é a fonte de verdade de contatos, canais, conversas, mensagens,
tentativas de envio, solicitações de orçamento, transições e eventos de
integração. n8n orquestra o fluxo, mas não escolhe estados de destino e Redis
não participa da consistência.

## Invariantes

- `companyId` vem do canal autenticado, da identidade de serviço ou do JWT;
- toda relação operacional possui chave estrangeira composta com `companyId`;
- somente `conversationState=bot-active` aceita outbound automático;
- inbound é gravado antes do evento em `integration_outbox`, na mesma transação;
- outbound e sua primeira tentativa são gravados como `pending` antes da
  Evolution API;
- existe no máximo uma conversa aberta por `companyId/channelId/contactId`;
- a resposta humana exige `human-active`, assignee autenticado,
  `expectedVersion` e chave de idempotência;
- o endpoint n8n força `automatic=true` e também exige `expectedVersion`;
- todo envio à Evolution passa por claim atômico com owner e lease antes da
  chamada; lease vencido entra em `unknown` e nunca autoriza reenvio cego;
- toda transição recebe `commandId` único e `expectedVersion`;
- fingerprints canônicos impedem reutilizar `commandId`/idempotency key com
  outro payload; replays devolvem o snapshot original do comando;
- n8n envia apenas o nome da transição; o backend valida a origem e calcula o
  destino;
- `whatsapp_conversation_transitions` é append-only, inclusive por trigger no
  PostgreSQL;
- confirmação de orçamento resulta em `sent-to-human` e `under-review`, nunca
  em `closed`.

## Modelo persistido

| Tabela                              | Responsabilidade                                       |
| ----------------------------------- | ------------------------------------------------------ |
| `whatsapp_providers`                | configuração e fingerprint da credencial Evolution     |
| `whatsapp_channels`                 | canal, instância, telefone e política do webhook       |
| `whatsapp_contacts`                 | identidade telefônica normalizada por tenant           |
| `whatsapp_conversations`            | estado canônico, assignee e versão otimista            |
| `whatsapp_messages`                 | inbound/outbound oficial e status de entrega           |
| `whatsapp_message_attempts`         | histórico de tentativas Evolution                      |
| `whatsapp_conversation_transitions` | log append-only de cada transição                      |
| `quote_requests`                    | solicitações versionadas e dados estruturados          |
| `integration_inbox`                 | deduplicação de Evolution e comandos n8n               |
| `integration_outbox`                | publicação confiável backend → n8n                     |
| `service_identities`                | identidade n8n com segredo armazenado somente por hash |
| `tenant_departments`                | departamento padrão persistido                         |

As tabelas legadas `outbox_events` e `inbox_receipts` continuam preservadas por
compatibilidade, mas o WhatsApp usa exclusivamente `integration_outbox` e
`integration_inbox`.

## Estados canônicos

Os valores HTTP usam kebab-case:

- `department`: os dez códigos já usados pelo Tenant Web;
- `conversationState`: `bot-active`, `waiting-for-customer`,
  `sent-to-human`, `human-active`, `closed`;
- `flowStep`: `main-menu`, `commercial-menu`, `quote-data-collection`,
  `quote-summary-confirmation`, `quote-send-pending`,
  `commercial-follow-up-menu`, `human-service`, `closed`;
- `requestStatus`: `not-started`, `collecting-information`,
  `waiting-for-customer`, `under-review`, `approved`, `rejected`, `cancelled`;
- `direction`: `inbound`, `outbound`;
- `deliveryStatus`: `received`, `pending`, `sent`, `delivered`, `read`,
  `failed`.

## Matriz MVP

| Evento                                               | Estado resultante                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Primeiro contato                                     | `commercial / bot-active / main-menu / not-started`                                                                   |
| Seleciona Comercial                                  | `commercial / bot-active / commercial-menu / not-started`                                                             |
| Inicia orçamento                                     | `commercial / bot-active / quote-data-collection / collecting-information`                                            |
| Resumo apresentado                                   | `commercial / waiting-for-customer / quote-summary-confirmation / waiting-for-customer`, com `resumeState=bot-active` |
| Cliente responde ao resumo                           | retoma `bot-active` mantendo `quote-summary-confirmation`; não abre menu de acompanhamento                            |
| Solicita correção                                    | volta para coleta e preserva os campos já persistidos                                                                 |
| Confirma resumo                                      | `commercial / sent-to-human / quote-send-pending / under-review`                                                      |
| Mensagem complementar logo após confirmação          | permanece encaminhada ao humano, sem reativar automação                                                               |
| Novo inbound após `WHATSAPP_FOLLOW_UP_INACTIVITY_MS` | `commercial / bot-active / commercial-follow-up-menu / <status atual>`                                                |
| Novo inbound em atendimento humano                   | persiste no histórico/fila, sem reativar o bot                                                                        |
| Nova solicitação                                     | cria outro `QuoteRequest` com `sequence` incrementado                                                                 |

`start-quote` existe apenas no `commercial-menu`; no acompanhamento, somente
`new-quote-request` cria um orçamento novo. Orçamento confirmado é imutável.

Transições aceitas: `present-main-menu`, `select-commercial`, `start-quote`,
`present-quote-summary`, `correct-quote`, `confirm-quote`,
`new-quote-request`, `return-to-main-menu`, `take-over`, `return-to-bot`,
`forward`, `mark-read`. `resume-awaited-reply` e
`resume-contextual-contact` são reservadas ao webhook.

### Captura durante atendimento humano

Em `sent-to-human`, `human-active` ou `human-service`, cada webhook inbound é
persistido como uma mensagem individual e incrementa `unreadCount` na mesma
transação que cria sua notificação na outbox. O histórico e o contador exibidos
pelo Tenant Web são lidos do PostgreSQL; portanto, não dependem do n8n, do Redis
ou da conclusão da notificação assíncrona. Se o cliente enviar várias mensagens,
nenhuma delas é reduzida a uma única “próxima mensagem”.

O MVP não agrupa mensagens automatizáveis da mesma conversa. Cada inbound é um
evento próprio e a outbox preserva ordem estrita até o completion do evento
anterior. Um eventual buffer/debounce no n8n não pode ser tratado como fonte de
verdade nem como garantia de captura.

## Webhook Evolution

Endpoint:

```text
POST /api/v1/webhooks/evolution/{channelId}
```

Integração nativa recomendada: configure um header estático na Evolution:

```text
x-evolution-webhook-token: <EVOLUTION_WEBHOOK_SECRET>
```

O backend valida o token em tempo constante, a instância, a idade de
`data.messageTimestamp` (`WEBHOOK_MAX_EVENT_AGE_MS`) e deduplica pelo
`data.key.id`. Como alternativa para um proxy assinador, são aceitos:

```text
x-evolution-timestamp: <unix seconds or milliseconds>
x-evolution-signature: sha256=<HMAC-SHA256(secret, timestamp.rawBody)>
```

O banco armazena somente SHA-256 do segredo e o serviço confirma que a
credencial do ambiente corresponde ao canal. A Evolution não precisa produzir
headers dinâmicos no modo de token estático.

No MVP há um único canal Evolution por instalação. O
`EVOLUTION_WEBHOOK_SECRET` deve ser exclusivo dessa instalação e nunca deve ser
reutilizado entre tenants, canais ou ambientes.

O webhook valida janela de timestamp, instância, shape mínimo, `remoteJid`,
tipo/tamanho/URL de anexo e telefone E.164. `fromMe` e grupos são ignorados
conforme a configuração do canal. O `data.key.id` é a chave idempotente.

Anexos não são baixados no MVP. A API guarda somente metadados aprovados:
MIME, tamanho, URL HTTPS e nome; `WHATSAPP_MAX_ATTACHMENT_BYTES` e
`WHATSAPP_ALLOWED_MIME_TYPES` controlam os limites.

## Autenticação n8n

Endpoints internos usam:

```text
Authorization: Bearer <N8N_SERVICE_KEY_ID>.<N8N_SERVICE_SECRET>
```

O token completo é armazenado somente como SHA-256 em `service_identities`.
Cada request resolve o `companyId` pela identidade; o cliente não envia tenant
no corpo ou na URL.

## Endpoints

### Internos

| Método e rota                                                     | Uso                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------- |
| `POST /internal/whatsapp/conversations/{id}/transitions`          | aplica transição nomeada                                  |
| `PATCH /internal/whatsapp/quote-requests/{id}`                    | patch estruturado e versionado                            |
| `POST /internal/whatsapp/conversations/{id}/messages/outbound`    | cria mensagem automática versionada e tentativa `pending` |
| `POST /internal/whatsapp/messages/{id}/evolution-dispatch-claims` | reserva atomicamente a tentativa antes do envio           |
| `POST /internal/whatsapp/messages/{id}/evolution-result`          | registra resultado e `providerMessageId`                  |
| `POST /internal/whatsapp/outbox-events/{id}/completions`          | conclui uma execução n8n aceita                           |
| `GET /internal/whatsapp/conversations/{id}`                       | refaz leitura após HTTP 409                               |

Todos ficam sob `/api/v1` e exigem a identidade n8n. Transição, patch e
outbound usam `expectedVersion`. O outbound aceita `purpose=main-menu` para que
a entrega Evolution grave `mainMenuPresentedAt`; apenas o primeiro inbound
recebe `isFirstContact=true`, mesmo quando mensagens chegam em paralelo. Em
conflito, a API responde 409 com
`details.currentVersion`.

O claim Evolution usa `EVOLUTION_DISPATCH_LEASE_MS`. Claims e resultados da
mesma tentativa são serializados por um lock transacional compartilhado: apenas
um claim concorrente recebe `shouldSend=true`. Se o worker cair depois do claim,
inclusive se repetir o mesmo `commandId` após o lease expirar, a tentativa passa
para `state=unknown` e `requiresReconciliation=true`. Consulte a Evolution: se
ela confirmar envio, registre `evolution-result`; apenas se confirmar ausência
de envio faça novo claim com `reconciliation=confirmed-not-sent`. Resultados
concorrentes também são monotônicos: um `failed` tardio nunca regride uma
mensagem já confirmada como `sent`, `delivered` ou `read`.

### Painel

| Método e rota                                             | Uso                                       |
| --------------------------------------------------------- | ----------------------------------------- |
| `GET /whatsapp/conversations`                             | lista paginada e filtros                  |
| `GET /whatsapp/conversations/{id}`                        | detalhe e solicitação atual               |
| `GET /whatsapp/conversations/{id}/messages`               | mensagens paginadas                       |
| `GET /whatsapp/conversations/{id}/transitions`            | auditoria paginada                        |
| `GET /whatsapp/conversations/{id}/quote-request`          | solicitação atual                         |
| `POST /whatsapp/conversations/{id}/messages`              | persiste resposta humana e solicita envio |
| `POST /whatsapp/conversations/{id}/actions/take-over`     | assume atendimento                        |
| `POST /whatsapp/conversations/{id}/actions/return-to-bot` | devolve ao bot                            |
| `POST /whatsapp/conversations/{id}/actions/forward`       | encaminha departamento                    |
| `POST /whatsapp/conversations/{id}/actions/mark-read`     | zera não lidas                            |

O JWT fornece `companyId` e usuário ator. Leitura exige
`whatsapp-conversations:view` ou `:manage`; ações exigem `:manage`.

## Outbox backend → n8n

O dispatcher reivindica apenas `whatsapp.inbound.persisted`,
`whatsapp.inbound.human-notification` e `whatsapp.outbound.requested`. Ele
envia um envelope com `schemaVersion=1.0`, `aggregateSequence`,
`executionId`, `automationAllowed`,
`canGenerateReply`, `canSendReply` e `isFirstContact`, além de `eventId`,
`correlationId`, tópico, agregado e payload. HTTP `202` confirma apenas aceite:
o evento permanece `processing` até o callback de completion. Falhas HTTP
voltam a `pending` com backoff exponencial limitado. Ausência do callback por
`N8N_EXECUTION_TIMEOUT_MS` redistribui o mesmo `eventId` com novo
`executionId`. Após oito tentativas, eventos ficam `dead`. Locks expirados são
recuperados. Somente o primeiro evento não entregue de cada conversa pode ser
reivindicado; nem mesmo um HTTP `202` libera o sucessor, pois o predecessor
precisa chegar a `delivered` pelo completion. `N8N_DISPATCH_BATCH_SIZE` permite
paralelismo entre agregados independentes, não batching de mensagens da mesma
conversa. Réplicas usam claim SQL atômico com `FOR UPDATE SKIP LOCKED`.

Headers enviados:

```text
Authorization: Bearer <N8N_OUTBOUND_SECRET>
x-lume-event-id: <outbox id>
x-lume-execution-id: <execution UUID>
x-lume-correlation-id: <correlation id>
```

O n8n deve deduplicar por `x-lume-event-id` e ecoar o `executionId` atual no
completion. `succeeded` marca `delivered`; `retryable-failure` volta a
`pending`; `terminal-failure` marca `dead`. O `commandId` do completion é
idempotente e fingerprintado. Callback de execução antiga recebe 409 e nunca
regrede `delivered`/`dead`. O readiness expõe `pendingOutbox`,
`acceptedOutbox`, `expiredExecutionOutbox` e `deadOutbox`; logs usam
IDs/correlação e não gravam payload, telefone, CPF ou tokens.

O readiness também expõe `evolutionDispatchesRequiringReconciliation` e mantém
`unknownEvolutionDispatches` como alias compatível. O contador inclui
tentativas `unknown` e leases `leased` já expirados. Valor maior que zero exige
reconciliação com a Evolution antes de qualquer novo claim; ele não inclui
telefone, mensagem ou outro dado do cliente.

Um evento `dead` bloqueia intencionalmente os sucessores do mesmo agregado.
Para recuperar: pause o dispatcher, confirme no n8n pelo `x-lume-event-id` que
o evento não foi processado (ou que sua deduplicação está ativa), faça backup
e, em transação, bloqueie a linha com `SELECT ... FOR UPDATE` e altere somente
ela de `dead` para `pending`, zerando `attempts`, definindo
`available_at=now()` e limpando `locked_at`, `lock_id`, `execution_id`,
`accepted_at`, `execution_lease_until` e `last_error`. Nunca apague nem marque
manualmente como `delivered`; depois retome o dispatcher e acompanhe a
sequência.

## Retenção

`WHATSAPP_RETENTION_DAYS` remove mensagens e tentativas antigas;
`INTEGRATION_RETENTION_DAYS` remove inbox antiga e outbox já entregue. Contatos,
conversas, solicitações, transições e auditoria não são apagados pelo job.
`RETENTION_JOB_ENABLED=false` desliga o job, inclusive em E2E.

## Bootstrap

`npm.cmd run tenant:bootstrap` é idempotente. Ele sincroniza:

- tenant licenciado;
- administrador e papéis padrão;
- departamento Comercial;
- provider e canal Evolution;
- identidade n8n.

O primeiro bootstrap exige `TENANT_ADMIN_PASSWORD`. Execuções posteriores não
alteram a senha existente e podem omitir essa variável. Nenhum contato,
conversa, mensagem ou solicitação fictícia é criado.

## Teste E2E

`TEST_DATABASE_URL` deve apontar para banco descartável cujo nome contenha
`test`. O E2E executa `prisma migrate reset --force` nesse banco antes de subir
a aplicação HTTP; nunca use uma URL de produção.
