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
- a resposta do atendente exige `human-active`, responsável autenticado,
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
- confirmação de orçamento resulta em `bot-active`,
  `commercial-follow-up-menu` e `under-review`; a automação só deixa de conduzir
  automaticamente quando uma ação humana explícita assume/encaminha a conversa
  ou quando a entrega do PDF passa a aguardar o cliente.

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
| `tenant_departments`                | cadastro idempotente das nove filas do WhatsApp        |

As tabelas legadas `outbox_events` e `inbox_receipts` continuam preservadas por
compatibilidade, mas o WhatsApp usa exclusivamente `integration_outbox` e
`integration_inbox`.

## Estados canônicos

Os valores HTTP usam kebab-case:

- `department`: as nove filas canônicas do WhatsApp usam `commercial`,
  `purchasing`, `controlling`,
  `personnel-department`, `financial`, `management`, `maintenance`,
  `monitoring` e `operations`;
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

No cadastro de usuários, o código público `controllership` é normalizado para o
valor persistido `controlling` e volta a ser apresentado como `controllership`
pelos contratos de usuário, permitindo edição round-trip. `controlling`
continua sendo o código HTTP do WhatsApp.
Os departamentos legados `human-resources`, `cleaning` e
`information-technology` permanecem aceitos na leitura de vínculos existentes,
mas não fazem parte do catálogo público de novas atribuições nem das nove filas
do Painel WhatsApp.

## Matriz MVP

| Evento                                               | Estado resultante                                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Primeiro contato                                     | `commercial / bot-active / main-menu / not-started`                                                                          |
| Seleciona Comercial                                  | `commercial / bot-active / commercial-menu / not-started`                                                                    |
| Seleciona opção 2 a 9                                | mantém `bot-active/main-menu`, persiste `departmentContactOption` e solicita nome e motivo                                   |
| Responde nome e motivo                               | notifica o telefone interno; após entrega confirmada usa `forward`, limpa `departmentContactOption` e mantém a fila canônica |
| Inicia orçamento                                     | `commercial / bot-active / quote-data-collection / collecting-information`                                                   |
| Resumo apresentado                                   | `commercial / waiting-for-customer / quote-summary-confirmation / waiting-for-customer`, com `resumeState=bot-active`        |
| Cliente responde ao resumo                           | retoma `bot-active` mantendo `quote-summary-confirmation`; não abre menu de acompanhamento                                   |
| Solicita correção                                    | volta para coleta e preserva os campos já persistidos                                                                        |
| Confirma resumo                                      | `commercial / bot-active / commercial-follow-up-menu / under-review`                                                         |
| Mensagem complementar logo após confirmação          | permanece automatizável; após o intervalo contextual o webhook muda para `commercial-follow-up-menu`                         |
| Novo inbound após `WHATSAPP_FOLLOW_UP_INACTIVITY_MS` | `commercial / bot-active / commercial-follow-up-menu / <status atual>`                                                       |
| Painel devolve orçamento ao bot                      | `commercial / bot-active / commercial-follow-up-menu / <status atual>` e agenda o menu no próximo inbound                    |
| Opção 1 a 4 ou conteúdo inválido no acompanhamento   | responde pelo n8n e depois usa `forward` para o Comercial                                                                    |
| Opção 0 no acompanhamento                            | envia o menu principal e aplica `return-to-main-menu`                                                                        |
| Novo inbound em atendimento humano                   | persiste no histórico/fila, sem reativar o bot                                                                               |

`start-quote` existe apenas no `commercial-menu`. `new-quote-request` cria um
novo ciclo sequencial na mesma conversa quando o orquestrador inicia outra
coleta a partir do acompanhamento. Cada conversa nova também começa sua própria
sequência. Confirmar um ciclo promove somente a solicitação corrente para
`under-review`. Se `new-quote-request` substituir um ciclo ainda
`under-review`, a mesma transação marca o anterior como `cancelled`, incrementa
sua versão, grava `decisionReason="Substituído por uma nova solicitação de
orçamento."` e `decidedAt`, e registra a substituição na transição e na
auditoria. Ciclos
entregues ou decididos permanecem imutáveis no histórico. Orçamento confirmado
é imutável fora dessa substituição explícita.

Transições aceitas: `present-main-menu`, `select-commercial`,
`start-department-contact`, `start-quote`, `present-quote-summary`,
`correct-quote`, `confirm-quote`,
`new-quote-request`, `return-to-main-menu`, `take-over`, `return-to-bot`,
`forward`, `mark-read`, `close`. `close-after-rejection` permanece somente
como alias de compatibilidade e é persistido como `close` pelas rotas do
painel. `resume-awaited-reply` e
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
outbound usam `expectedVersion`. O outbound aceita `purpose=main-menu` e
`purpose=commercial-follow-up-menu` para que a entrega Evolution grave,
respectivamente, `mainMenuPresentedAt` e `followUpMenuPresentedAt`.
`purpose=department-notification` exige `recipientPhone`, persiste o
destinatário real antes da Evolution e não altera a prévia da conversa nem
aparece na listagem de mensagens do painel.
`purpose=unsupported-message-kind` é a única exceção à supressão automática
fora de `bot-active`: exige `kind=text`, o texto canônico documentado no
workflow — `No momento não consigo ler, ver ou ouvir este tipo de mensagem.
Por favor, envie sua mensagem em texto para continuarmos o atendimento.` —,
ausência de mídia e destinatário alternativo e
`inReplyToMessageId` apontando para um inbound não textual da mesma conversa.
Essa resposta não altera estado, responsável ou versão e não autoriza a IA nem
outros envios automáticos. Apenas o primeiro inbound recebe
`isFirstContact=true`, mesmo quando mensagens chegam em paralelo. Em conflito,
a API responde 409 com `details.currentVersion`.

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

| Método e rota                                                     | Uso                                             |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| `GET /whatsapp/conversations`                                     | lista paginada e filtros                        |
| `GET /whatsapp/conversations/dashboard`                           | indicadores limitados ao departamento           |
| `GET /whatsapp/conversations/{id}`                                | detalhe, solicitação e último encerramento      |
| `GET /whatsapp/conversations/{id}/messages`                       | mensagens e anexos paginados                    |
| `GET /whatsapp/conversations/{id}/transitions`                    | auditoria paginada com ator                     |
| `GET /whatsapp/conversations/{id}/quote-request`                  | solicitação atual                               |
| `POST /whatsapp/conversations/{id}/messages`                      | persiste resposta do atendente e solicita envio |
| `POST /whatsapp/conversations/{id}/actions/take-over`             | assume atendimento                              |
| `POST /whatsapp/conversations/{id}/actions/return-to-bot`         | devolve ao bot                                  |
| `POST /whatsapp/conversations/{id}/actions/forward`               | encaminha departamento                          |
| `POST /whatsapp/conversations/{id}/actions/mark-read`             | zera não lidas                                  |
| `POST /whatsapp/conversations/{id}/actions/close`                 | encerra conversa sem proposta ativa             |
| `POST /whatsapp/conversations/{id}/actions/close-after-rejection` | alias legado da rota canônica                   |

O JWT fornece `companyId` e usuário ator. A leitura do painel exige
`whatsapp-conversations:view` ou `:manage`. A leitura de orçamentos e PDFs
também aceita `commercial:view` ou `commercial:manage`, sempre combinada ao
vínculo real com o departamento Comercial. Mutações de orçamento exigem
`commercial:manage` ou `whatsapp-conversations:manage` e preservam a mesma
barreira departamental.
O endpoint de indicadores do dashboard exige `dashboard:view` e impõe no
servidor um dos departamentos atribuídos ao usuário. Perfis com múltiplos
departamentos devem informar um deles em cada consulta. Somente um perfil com
`whatsapp-conversations:manage` e sem departamento atribuído pode consultar o
total do tenant sem esse filtro.

`return-to-bot` também aceita
`waiting-for-customer/quote-send-pending/approved` quando não existe atendente
responsável. A transição não envia nada por conta própria: muda imediatamente
para `bot-active/commercial-follow-up-menu`, limpa o responsável e agenda o
menu de acompanhamento para o próximo inbound por
`contextualFollowUpAt=1970-01-01T00:00:00.000Z`. Se houver atendente atribuído,
esse atalho é recusado.

`close` aceita uma conversa aberta somente quando não existe solicitação
vinculada em `collecting-information`, `waiting-for-customer` ou
`under-review`, nem documento de proposta em `queued`. A proteção adicional que
impede encerramento quando existe proposta aprovada foi preservada no domínio,
mas está desabilitada no MVP por
`WHATSAPP_PREVENT_CLOSE_WITH_APPROVED_QUOTE=false`. Quando essa flag voltar a
`true`, uma aprovação em qualquer ciclo histórico também bloqueará o
encerramento. O corpo mantém `commandId`,
`expectedVersion` e aceita `reason` entre 3 e 500 caracteres. Quando a proposta
mais recente ou o estado corrente é `rejected`, precisa existir um motivo
efetivo: o informado no comando ou o `decisionReason` já persistido.

A transição limpa responsável, retomada contextual e contagem de não lidas,
preserva o status comercial para auditoria e grava `closedAt`. A mesma transação
persiste uma mensagem outbound `pending`, sua tentativa e
`whatsapp.outbound.requested`, além de registrar
`whatsapp.conversation.close` em `tenant_audit_logs`. A mensagem agradece o
contato e escolhe “um ótimo dia”, “uma ótima tarde” ou “uma ótima noite” pelo
horário de `America/Sao_Paulo`. Se qualquer escrita falhar, o encerramento
inteiro é revertido. O detalhe expõe o último encerramento e o log append-only
preserva todos eles com data e hora, ator e motivo. Um inbound posterior do
mesmo contato não reabre o agregado encerrado: cria uma nova conversa em
`bot-active/main-menu/not-started`, apta a receber o menu inicial pelo n8n.

O endpoint de mensagens continua sendo a única fronteira de envio pelo
atendente. Ele persiste a mensagem outbound e sua tentativa antes de publicar
`whatsapp.outbound.requested`; os endpoints de leitura fornecem o histórico,
estado de entrega e metadados seguros dos anexos para o painel. Mensagens
enviadas por um atendente expõem `sentBy: { id, name }`; mensagens automáticas
mantêm `sentBy=null`.

`GET /whatsapp/conversations` aceita `department`, `state`, `requestStatus`,
`search`, `page` e `pageSize`. `requestStatus` representa exclusivamente o
processo Comercial: quando informado sem departamento, a API força
`department=commercial`; combiná-lo com outra fila retorna `400`. Os índices
`companyId + department + conversationState + updatedAt` e
`companyId + department + requestStatus + updatedAt` sustentam a paginação das
filas sem criar outro dono de estado.

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

## Proposta comercial em PDF

O PDF do orçamento pertence ao Tenant API. O navegador nunca chama n8n nem
Evolution diretamente.

O fluxo do MVP é:

Antes de `present-quote-summary` ou `confirm-quote`, `departureDate` é
obrigatória. `departureAt` é opcional e pode continuar nulo quando o cliente
ainda não conhece o horário. Se existir, o instante precisa corresponder à data
civil no fuso `America/Sao_Paulo`. `returnDate` e `returnAt` são opcionais e não
podem representar retorno anterior à saída.

1. `GET /whatsapp/quote-proposals?stage=pending` lista solicitações confirmadas
   em `under-review` vinculadas a conversas comerciais abertas. O predicado
   pertence ao ciclo de orçamento e não depende da condução transitória da
   conversa; assim, `bot-active`, uma intervenção do atendente ou
   `sent-to-human/human-service` não ocultam a solicitação pendente.
   `stage=sent` lista solicitações em `waiting-for-customer` que já possuem ao
   menos um documento `sent` e ainda aguardam decisão;
2. `POST /whatsapp/quote-proposals/{quoteRequestId}/documents`, em
   `multipart/form-data`, valida e persiste um PDF no PostgreSQL. O painel pode
   repetir o upload com outro `commandId` para vincular vários PDFs à mesma
   solicitação;
3. o upload não envia mensagem e não altera a versão da conversa;
4. `POST /whatsapp/quote-proposals/{quoteRequestId}/send` cria, na mesma
   transação, a mensagem `document/pending`, sua primeira tentativa e o evento
   ordenado `whatsapp.outbound.requested`. Cada documento recebe sua própria
   chamada. Todas elas reutilizam um `batchId` e o array completo e ordenado
   `batchDocumentIds`; a API vincula somente esses IDs, sem capturar uploads
   órfãos. A elegibilidade vem do `QuoteRequest` corrente, confirmado e ainda
   apto a receber documentos; ela não depende do `flowStep`, do estado de
   condução ou do menu visual atual da conversa. Assim, um orçamento
   `under-review` continua enviável depois de ser encaminhado ao atendimento.
   O primeiro envio realizado sem responsável vincula a conversa ao usuário
   autenticado, muda o passo para `quote-send-pending` e conserva
   `bot-active/under-review`;
5. n8n baixa o conteúdo pelo endpoint interno autenticado, adquire o claim da
   tentativa, envia pelo provedor e registra `evolution-result`;
6. cada resultado `sent`, `delivered` ou `read` acompanhado de
   `providerMessageId` confirma somente o documento correspondente. A conversa
   e a solicitação passam a `waiting-for-customer` apenas depois que todos os
   documentos do lote atual estiverem `sent`. Qualquer `failed` conserva
   `under-review`; o documento pode ser reenviado com o mesmo `batchId`,
   `batchDocumentIds` e um novo `commandId`;
7. o primeiro inbound posterior aplica `proposal-response-received` e cria
   `whatsapp.inbound.human-notification`, mantendo o bot suprimido e entregando
   a resposta ao atendimento.

Enquanto o documento estiver `queued`, takeover, devolução ao bot e
encaminhamento retornam `409`. A confirmação da Evolution serializa pela
conversa e atualiza documento, solicitação e conversa sob a mesma
pré-condição; uma divergência faz a transação inteira falhar para reconciliação.
Além disso, uma completion `succeeded` de `whatsapp.outbound.requested` só é
aceita depois de mensagem e tentativa registrarem o resultado positivo da
Evolution.

O modelo `quote_proposal_documents` armazena o binário `bytea`, nome, MIME,
tamanho, SHA-256, autor, tenant, conversa, solicitação, mensagem vinculada e
datas do ciclo `uploaded -> queued -> sent|failed`. As chaves compostas impedem
que um documento, orçamento ou usuário de outro tenant seja associado. As
relações de solicitação e mensagem também incluem `conversation_id`, impedindo
que registros do mesmo tenant, porém de conversas diferentes, sejam combinados.
As respostas de lista mantêm `proposalDocument` como alias compatível para o
documento mais recente e expõem `documents` com o histórico completo.

### Contrato HTTP do painel

Uma conversa pode possuir várias solicitações, identificadas por `sequence`.
Solicitações cadastradas pelo painel registram `requested_by_user_id`; as
coletadas pelo bot são apresentadas como solicitadas pelo cliente via WhatsApp.
O documento registra separadamente quem fez o upload e quem confirmou o envio.
Após a entrega, a decisão comercial usa o próprio `QuoteRequest.status`
(`approved|rejected`) e registra `decided_at`, `decided_by_user_id` e o motivo
obrigatório da recusa. A decisão da solicitação corrente também atualiza
`WhatsAppConversation.requestStatus`, sem permitir que uma decisão histórica
sobrescreva o estado de uma solicitação mais recente.

`new-quote-request` sempre cria uma nova sequência. Uma solicitação anterior em
`waiting-for-customer` permanece imutável no histórico e não impede que a mesma
conversa ou telefone volte a `collecting-information` para um novo orçamento.
Quando a solicitação anterior ainda está `under-review`, o novo ciclo a
substitui: ela passa a `cancelled`, sai da fila, da contagem e da notificação,
mas permanece consultável no histórico com sua versão, documentos e auditoria.
A transição é recusada enquanto existir documento `queued`, evitando cancelar
um lote já entregue à outbox. O predicado da fila usa somente solicitações
confirmadas ainda `under-review`, portanto um ciclo substituído ou um PDF
entregue anteriormente não cria pendência fantasma.

| Método e rota                                                                   | Resultado                                                                                                   |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /whatsapp/quote-proposals?stage=pending&page=1&pageSize=20`                | fila autoritativa aguardando PDF, com resumo, conversa e todos os documentos                                |
| `GET /whatsapp/quote-proposals?stage=sent&page=1&pageSize=20`                   | PDFs entregues em `waiting-for-customer`, ainda aguardando decisão                                          |
| `GET /whatsapp/quote-proposals?stage=approved&page=1&pageSize=20`               | solicitações aprovadas                                                                                      |
| `GET /whatsapp/quote-proposals?stage=cancelled&page=1&pageSize=20`              | solicitações recusadas ou substituídas, com motivo e data                                                   |
| `POST /whatsapp/quote-proposals`                                                | cria nova solicitação na conversa com os campos coletados pela IA, autoria, `commandId` e `expectedVersion` |
| `GET /whatsapp/quote-proposals/{quoteRequestId}`                                | resumo, conversa e histórico de documentos                                                                  |
| `PATCH /whatsapp/quote-proposals/{quoteRequestId}/decision`                     | marca a proposta enviada como `approved` ou `rejected`; recusa exige `reason`                               |
| `PATCH /whatsapp/quote-proposals/{quoteRequestId}/status`                       | altera manualmente o status do orçamento atual; exige responsável, versão e auditoria                       |
| `POST /whatsapp/quote-proposals/{quoteRequestId}/documents`                     | upload multipart com `file`, `commandId` e `expectedVersion`                                                |
| `POST /whatsapp/quote-proposals/{quoteRequestId}/send`                          | JSON com `commandId`, `proposalDocumentId`, `batchId`, `batchDocumentIds` e `expectedVersion`               |
| `GET /whatsapp/quote-proposals/{quoteRequestId}/documents/{documentId}/content` | download autenticado do PDF                                                                                 |

As quatro listagens aceitam `search`, `createdFrom`, `createdTo` e
`conversationId`. Este último é um UUID e limita a resposta a uma única
conversa, permitindo ao painel abrir a lista completa de seus orçamentos sem
misturar ciclos do mesmo telefone. A busca
abrange cliente, telefone, origem, destino e nome do arquivo. Cada resposta
inclui `summary={pending,sent,approved,cancelled}` calculado com os mesmos
filtros, além de `summary.cancellationReasons=[{reason,count}]` agregado sem
depender da página corrente e de repetir os filtros normalizados.
`stage=cancelled` agrega `rejected` e `cancelled`;
`quoteRequest.decision.reason` traz o motivo recusado ou a explicação canônica
do ciclo substituído. Registros legados recusados sem motivo são agrupados como
`Motivo não informado (registro legado).`.
As quatro categorias são mutuamente exclusivas pelo status da solicitação:
`sent` não repete registros que já passaram para `approved`, `rejected` ou
`cancelled`.

Toda conversa apresentada inclui `hasApprovedQuoteRequest`, calculado sobre
qualquer ciclo aprovado. A política capaz de impedir o encerramento permanece
implementada na API, mas fica desabilitada no MVP por
`WHATSAPP_PREVENT_CLOSE_WITH_APPROVED_QUOTE=false`. A conversa ainda não pode
ser encerrada quando existe outro ciclo em coleta, aguardando cliente ou em
análise, nem quando há documento em envio.

`expectedVersion` sempre representa a versão da conversa. Cada upload apenas
confere a versão e retorna
`{proposalDocument,conversation:{id,version},idempotent}`; portanto, se a
confirmação falhar, o painel pode repetir somente `/send` usando o
`proposalDocumentId` já persistido. `batchDocumentIds` aceita de 1 a 10 UUIDs
únicos, deve incluir o `proposalDocumentId` corrente e não pode mudar depois do
primeiro envio do `batchId`. O envio incrementa a versão da conversa uma vez por
documento, mantém ou define o atendente responsável e conserva
`bot-active/under-review` até a confirmação integral do lote pelo provedor.
Somente essa confirmação muda a solicitação para `waiting-for-customer`. Tentar
criar, enviar,
carregar ou decidir uma proposta em conversa encerrada retorna `409` com
`code=QUOTE_CONVERSATION_CLOSED`; na criação, a mensagem pública é
`Não é possível cadastrar proposta em um atendimento encerrado.`.

Uploads aceitam exclusivamente:

- um arquivo com extensão `.pdf`;
- `Content-Type: application/pdf`;
- tamanho entre 1 byte e 10 MiB;
- assinatura inicial `%PDF-`;
- marcador `%%EOF` nos últimos 2 KiB.

O servidor calcula o SHA-256; valores fornecidos pelo cliente não são
confiáveis. `commandId` torna upload e envio idempotentes. Reutilizar a mesma
chave com conteúdo diferente retorna `409`; versão obsoleta também retorna
`409` com `details.currentVersion`.

O nome original do multipart é normalizado antes da persistência para reparar
o caso conhecido em que UTF-8 foi interpretado como Latin-1 (`OrÃ§amento` →
`Orçamento`). Nomes já válidos não são regravados. O nome normalizado é o que
segue para o documento e para o WhatsApp.

Essas verificações validam o contrato e a estrutura mínima esperada pelo MVP;
não substituem varredura antimalware. Se a política de produção exigir essa
camada, o documento deve receber um estado de quarentena e só passar a
`uploaded` após o scanner corporativo marcá-lo como limpo.

### Contrato interno para o n8n

O evento mantém o tópico `whatsapp.outbound.requested` e informa:

```json
{
  "message": {
    "kind": "document",
    "deliveryStatus": "pending",
    "text": "Segue o orçamento solicitado.",
    "media": {
      "documentId": "<uuid>",
      "fileName": "orcamento.pdf",
      "mimetype": "application/pdf",
      "sizeBytes": 12345,
      "sha256": "<64 hex>",
      "downloadPath": "/internal/whatsapp/proposal-documents/<uuid>/content",
      "caption": "Segue o orçamento solicitado."
    }
  },
  "automatic": false,
  "automationAllowed": false,
  "canGenerateReply": false,
  "canSendReply": true
}
```

`LUME_TENANT_API_BASE_URL` já contém `/api/v1`; por isso `downloadPath` começa
em `/internal`, sem repetir o prefixo. O download
`GET /internal/whatsapp/proposal-documents/{documentId}/content` exige a
identidade de serviço do n8n e aplica o tenant dessa identidade.

## Bootstrap

`npm.cmd run tenant:bootstrap` é idempotente. Ele sincroniza:

- tenant licenciado;
- administrador com departamento e permissões diretas;
- as nove filas departamentais do menu, com Comercial como padrão;
- provider e canal Evolution;
- identidade n8n.

O primeiro bootstrap exige `TENANT_ADMIN_PASSWORD`. Execuções posteriores não
alteram a senha existente e podem omitir essa variável. Nenhum contato,
conversa, mensagem ou solicitação fictícia é criado.

## Teste E2E

`TEST_DATABASE_URL` deve apontar para banco descartável cujo nome contenha
`test`. O E2E executa `prisma migrate reset --force` nesse banco antes de subir
a aplicação HTTP; nunca use uma URL de produção.
