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
sincronizar departamentos, permissões diretas da conta administrativa,
provider, canal e identidade n8n. Depois do
primeiro acesso, remova `TENANT_ADMIN_PASSWORD`; uma execução posterior não
redefine a senha.

Após o bootstrap, valide que o catálogo atribuível possui exatamente os nove
departamentos operacionais (Comercial, Compras, Controladoria, Departamento
Pessoal, Financeiro, Gerência, Manutenção, Monitoramento e Operacional).
Registros departamentais legados podem permanecer armazenados; não os recrie no
catálogo público. Confirme também que a conta administrativa canônica possui
`isAdministrator=true`, vínculos diretos vazios e que um usuário apenas Comercial não
recebe `users:*`, `settings:*` ou `license:view`.
Confirme também que uma conta apenas Gerência não recebe permissões comerciais;
para acessar Painel WhatsApp e Orçamentos ela precisa de vínculo explícito com
`commercial`.

Recuperação e reset administrativo de senha requerem um provedor de e-mail
funcional.
Configure `EMAIL_DELIVERY_ENABLED=true`,
`RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME`,
`RESEND_REQUEST_TIMEOUT_MS`, `PASSWORD_RESET_MIN_RESPONSE_MS`,
`PASSWORD_RESET_URL_BASE`, `SUPPORT_RECIPIENT_EMAIL` e `SUPPORT_CC_EMAIL`, e
valide uma entrega real antes de liberar as ações no
painel. Em produção, o envio de e-mail não pode ser desabilitado. Mantenha
`RESEND_API_URL` no endpoint HTTPS oficial. `RESEND_FROM_EMAIL` deve pertencer a
um domínio verificado no Resend; a API rejeita
`onboarding@resend.dev` quando `NODE_ENV=production`.

Para os chamados do Lume, configure
`SUPPORT_RECIPIENT_EMAIL=devops@mileniumturismo.com.br` e
`SUPPORT_CC_EMAIL=taiane.karine@mileniumturismo.com.br,taianekas.dev@outlook.com`.
`SUPPORT_CC_EMAIL` aceita uma lista separada por vírgulas; a API remove
duplicatas e nunca repete o destinatário principal na cópia.

Sem domínio próprio, `onboarding@resend.dev` pode ser usado somente em
desenvolvimento/sandbox. Nesse modo, o Resend restringe a entrega ao endereço da
própria conta Resend; configure temporariamente `SUPPORT_RECIPIENT_EMAIL` com
esse endereço. Enviar para a caixa corporativa ou para qualquer terceiro exige
um domínio verificado, com SPF e DKIM aprovados no Resend, e um remetente desse
domínio.

Crie a chave usada pela aplicação com permissão **Sending access**. O fluxo não
precisa de **Full access**. Mantenha `RESEND_API_KEY` apenas no `.env` local ou
no cofre de segredos do ambiente; nunca a exponha ao Tenant Web, ao navegador,
a logs ou ao Git. Se uma chave tiver sido exibida ou compartilhada, revogue-a e
gere outra com o menor privilégio.

Se o provedor rejeitar um reset, a conta permanece como estava e o novo link é
descartado. Valide que
`POST /auth/password/forgot` mantém resposta
idêntica para identificador existente e inexistente, que o token funciona uma
única vez em `POST /auth/password/change` e que a senha inicial retorna
`ACCOUNT_PASSWORD_SETUP_REQUIRED` com desafio `first-access`, sem criar access
ou refresh token.

Monitore auditorias `PASSWORD_RESET_DELIVERY_FAILED`. Elas contêm apenas o
código sanitizado da falha e um UUID de correlação. `RESEND_MAX_ATTEMPTS` deve
permanecer entre 1 e 3; as tentativas reutilizam a mesma chave de idempotência.

Valide também `POST /support/requests` com uma sessão real. O servidor deve
incluir nome, usuário e e-mail do solicitante sem aceitar esses campos do
navegador. O painel só deve liberar a contingência “Abrir no aplicativo de
e-mail” quando a resposta for `503` com
`EMAIL_DELIVERY_UNAVAILABLE` ou `SUPPORT_EMAIL_DELIVERY_FAILED` e
`details.fallbackAllowed=true`. Erros de validação ou autorização não autorizam
essa contingência.

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
- confirme que `20260728000300_user_access_and_status` e
  `20260728000400_drop_legacy_roles` e
  `20260728000500_user_administrator` e
  `20260729000100_whatsapp_legacy_import` estão incluídas na
  imagem;
- execute `prisma migrate deploy`;
- mantenha imagem anterior para rollback;
- nunca dependa da tag `latest`;
- atualize um cliente por vez.

## Ferramentas administrativas e arquivos

Prisma Studio não faz parte do processo normal de produção. Para uma janela
excepcional, registre responsável, motivo, host e banco; configure
`PRISMA_STUDIO_ALLOW_REMOTE=true`,
`PRISMA_STUDIO_ALLOW_PRODUCTION=true` e a confirmação exata
`PRISMA_STUDIO_CONFIRM_TARGET=host/banco`. Remova as três variáveis ao terminar.
Nunca exponha a porta 5555 publicamente.

O intercâmbio de arquivos exige quota, retenção e monitoramento de crescimento
do PostgreSQL. O parser e os conversores executam dentro do processo da API;
portanto, mantenha limites conservadores e não aumente
`DATA_EXCHANGE_MAX_FILE_BYTES` ou `DATA_EXCHANGE_MAX_TENANT_BYTES` sem teste de
carga. Antes de permitir PDFs externos em produção, acrescente scanner de
malware e parser estrutural. Consulte [data-exchange.md](data-exchange.md).

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
o recria. Depois do deploy, confirme:

- `prisma migrate status` sem migrações pendentes;
- `/users` com pesquisa, paginação e filtros de departamento, permissão e
  status, incluindo permissões implícitas e sem considerar permissões diretas
  fora do teto;
- ativação, desativação e suspensão com retomada automática após o prazo;
- somente administrador explícito cria/promove/rebaixa administrador, com
  bloqueio de auto-rebaixamento e preservação de ao menos um administrador
  ativo;
- login inicial retornando desafio de troca sem sessão; CPF não deve autenticar
  nem iniciar recuperação;
- foto JPEG/PNG/WebP válida dentro de 512 KB e 128–2048 px, além de HTTP 413
  para JSON acima de `HTTP_MAX_JSON_BODY_BYTES`;
- `/permissions` expondo somente departamentos e permissões diretas;
- `/license/status` bloqueado sem `management` + `license:view`;
- `/notifications` vazio fora do departamento Comercial e com apenas o
  agregado comercial para quem pertence a ele.

Só então execute o comando de publicação descrito acima.
