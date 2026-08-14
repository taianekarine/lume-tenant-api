# Arquitetura do Lume Tenant API

O módulo documental mantém estados e validação em `src/domain/documents`, casos
de uso em `src/application` e composição HTTP em `src/modules/documents`.
Solicitações guardam snapshots de checklists versionados para que alterações
futuras não modifiquem processos iniciados.

## Pipeline de históricos do WhatsApp

A importação assistida é uma camada de preparação, não um segundo importador.
O controller recebe um ZIP por requisição, o parser produz mensagens ordenadas
e metadados de anexos, e o revisor confirma o mapeamento. O gerador consolida
todos os itens nas tabelas `AtendimentosImportacao`, `MensagensImportacao` e
`DocumentosImportacao`. A gravação final delega ao `WhatsAppImportService`, que
continua sendo a única implementação das regras de associação, idempotência,
transação e reconciliação.

Manifestos e arquivos temporários são isolados por `companyId` e `batchId`, com
nomes derivados de hash e escrita atômica. A API limita entradas, tamanho
compactado e descompactado, rejeita caminhos absolutos, travessia de diretório,
symlinks e arquivos corrompidos. Somente um arquivo é analisado por vez; erros
ficam associados ao item e não cancelam o lote.

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
- usuários criados pelo painel recebem senha temporária e não obtêm sessão
  antes de substituí-la;
- alterações de senha preservam somente hashes bcrypt no histórico e impedem
  reutilização dentro de `PASSWORD_HISTORY_LIMIT`;
- links de criação de senha são opacos, expiram e são consumidos uma única vez;
- recuperação e reset administrativo exigem um provedor de e-mail configurado;
  o desafio é persistido antes do envio, e uma falha de entrega o remove,
  restaura o desafio anterior ainda válido e devolve a conta ao estado anterior;
- fotos de perfil ficam no PostgreSQL do próprio tenant, limitadas a 512 KB;
- todo funcionário recebe `dashboard:view`, `ai-agents:use`, `profile:view`,
  `profile:update`, `support:view` e `support:create` como permissões implícitas;
- permissões são recalculadas no banco a cada request autenticada;
- o `companyId` do JWT precisa corresponder ao tenant da licença;
- `GET /license/status` exige JWT, departamento `management` e
  `license:view`;
- não existem segredos nem tokens do control;
- a chave de licença instalada é pública.

O vínculo público de um usuário contém `departments[]` e
`permissionCodes[]`. O teto permitido é a união da matriz dos departamentos; a
permissão efetiva é formada pelas permissões implícitas mais permissões
individuais, sempre intersectadas com esse teto. Não existe resolução indireta
por cargo ou papel. Somente `management` contém `users:*`, `settings:*` e
`license:view`; o seu teto administrativo não inclui recursos comerciais nem
WhatsApp. Orçamentos exigem tanto a permissão quanto o departamento
`commercial`. Essa regra é aplicada no domínio e reforçada nos controllers de
usuários, catálogo de permissões, licença e propostas.

`isAdministrator` não é um cargo nem uma permissão materializada. Quando
verdadeiro, o presenter e o guard concedem o catálogo completo atual; a
persistência mantém `departments` e `permissionCodes` vazios. Somente um
administrador autenticado pode criar, promover ou rebaixar outro
administrador. `users:manage` isolado nunca eleva uma conta, e auto-rebaixamento
ou remoção do último administrador ativo são recusados.

O catálogo atribuível contém somente Comercial, Compras, Controladoria,
Departamento Pessoal, Financeiro, Gerência, Manutenção, Monitoramento e
Operacional. Valores legados permanecem aceitos para leitura e normalização,
sem voltar ao catálogo atribuível. O modelo de acesso contém apenas
departamentos e permissões diretas.

## Continuidade

O runtime não chama o control. A licença é validada com Ed25519 localmente.
Depois do vencimento existe um período de tolerância definido no documento.

Para WhatsApp, `integration_outbox` armazena eventos por tenant e possui
dispatcher interno da API com lock, correlação, retry e backoff.
`integration_inbox` deduplica webhooks Evolution e comandos internos.
`outbox_events` e
`inbox_receipts` permanecem apenas para compatibilidade com o contrato legado
do edge-agent.

## Camadas

```text
src/core          erros compartilhados
src/domain        entidades e políticas
src/application   casos de uso e contratos
src/infra         Prisma, JWT, bcrypt e licença offline
src/modules       composição NestJS e HTTP
src/shared        guards, filtros e utilitários
```

O módulo WhatsApp mantém a matriz pura em `src/domain/whatsapp`, casos de uso e
portas em `src/application`, transações Prisma e integrações em `src/infra` e
controllers/DTOs em `src/modules/whatsapp`.

## Contas e perfil

- `POST /auth/login` nunca autentica com a senha inicial. Depois de validar essa
  senha, responde `ACCOUNT_PASSWORD_SETUP_REQUIRED` sem emitir access ou
  refresh token e inclui `details.challengeToken`, `expiresAt` e
  `reason=first-access`;
- `POST /auth/password/forgot` recebe usuário ou e-mail e devolve a mesma
  resposta genérica para qualquer identificador;
- `POST /auth/password/change` consome o desafio e registra a nova senha;
- `POST /users/:id/password-reset` é restrito a `users:update`;
- `POST /users` e `PATCH /users/:id` recebem departamentos e permissões
  individuais;
- `GET /users` pagina e filtra por `search`, `department`, `permission` e
  `status`; o filtro de permissão usa a permissão efetiva, inclui as implícitas
  e ignora valores diretos armazenados fora do teto departamental;
- `PATCH /users/:id/status` mantém `status` e o campo legado `isActive`
  consistentes, revoga sessões e registra prazo e motivo da suspensão;
- `users:update` é a fronteira de edição de acesso e `users:manage` protege o
  estado da conta; `users:delete` não é publicado no catálogo delegável, e a
  exclusão lógica possui validação adicional de administrador no caso de uso e
  exige a confirmação da senha atual do administrador;

- `GET /users/me/profile`, `PUT /users/me/profile-picture` e
  `PATCH /users/me/password` operam somente sobre o principal autenticado;
- foto de perfil é validada pelo conteúdo real (assinatura/MIME e dimensões
  JPEG, PNG ou WebP), limitada a 512 KB e 128–2048 px. O parser HTTP possui
  limite JSON dedicado de 1 MB; o teto menor do webhook continua aplicado no
  caso de uso de entrada;
- todas as consultas e mutações usam o `companyId` resolvido pelo JWT e pela
  licença local.

## Métricas administrativas

`api_request_metrics` registra, em lote, apenas empresa, usuário, ação HTTP
normalizada, resultado, duração e bytes. Corpos, parâmetros, arquivos, senhas,
tokens e IP não são armazenados. O painel é exclusivo de administradores, aplica
isolamento por empresa e apresenta nomes humanizados em vez de rotas técnicas.
A retenção é definida por `API_USAGE_RETENTION_DAYS` (90 dias por padrão).

Contas possuem estado `active`, `inactive` ou `suspended`. Login, refresh e JWT
recusam contas não ativas. Ao consultar uma suspensão cujo
`suspendedUntil` expirou, o repositório a reativa atomicamente, limpa prazo e
motivo e incrementa `tokenVersion` antes de autenticar ou apresentar a conta.

Depois de configurar e validar `EMAIL_DELIVERY_ENABLED`, `RESEND_API_KEY`,
`RESEND_FROM_EMAIL` e `PASSWORD_RESET_URL_BASE`, a adoção segura é individual
e auditável:
um administrador usa `POST /users/:id/password-reset` (ou a ação equivalente
no painel) para cada conta escolhida. O usuário também pode iniciar o fluxo
não enumerável em `POST /auth/password/forgot`. O envio direto ao Resend usa
texto e HTML escapado, idempotência por desafio e inclui nome, usuário, e-mail,
link e validade. A solicitação pública apenas persiste o desafio: não força
troca, não incrementa `tokenVersion` e não revoga sessões antes de o token ser
consumido. O reset administrativo segue a mesma segurança pré-entrega; a
revogação ocorre atomicamente ao consumir o token. Um atraso mínimo
configurável reduz diferença temporal entre conta existente e inexistente.
Falhas após retentativas idempotentes restauram o desafio anterior e geram
`PASSWORD_RESET_DELIVERY_FAILED` com código sanitizado e UUID de correlação,
sem armazenar token ou segredo.

### Migração de acesso e status

`20260728000300_user_access_and_status` adiciona `permission_codes`, `status`,
`suspended_until` e `suspension_reason`, cria os índices de consulta e preserva
`is_active` por compatibilidade. O bootstrap identifica a conta administrativa
canônica da instalação.

`20260728000400_drop_legacy_roles` remove explicitamente as tabelas
`user_roles` e `roles` caso ainda existam em um banco pré-produção antigo. A
migration inicial também não cria mais essas estruturas no caminho de reset
limpo. Nenhuma permissão é materializada a partir delas. Edição e mudança de
status impedem auto-lockout.

`20260728000500_user_administrator` adiciona a autoridade administrativa
explícita sem promover usuários por heurística. O bootstrap define
deterministicamente a conta administrativa canônica e só exige primeiro acesso
enquanto o hash armazenado ainda corresponde à senha inicial configurada. As
operações de gestão garantem ao menos um administrador explícito ativo por
transação serializável com retry, inclusive sob despromoção e inativação
concorrentes.

## Notificações

`GET /notifications` não exige `whatsapp-conversations:manage`; exige apenas
uma identidade autenticada e ativa. O controller consulta os departamentos do
principal antes de acessar qualquer fila. No MVP, somente usuários com
`commercial` recebem o agregado de orçamentos pendentes; os demais recebem
`items: []` sem consulta aos dados comerciais.

O estado de leitura não é derivado de aprovação nem mantido no navegador.
`POST /notifications/commercial.pending-quote-proposals/read` grava, de forma
idempotente, um recibo por usuário, solicitação e versão atualmente pendente em
`quote_notification_reads`. `pendingTotal` representa a fila corrente;
`unreadTotal` representa somente itens dessa fila sem recibo para o usuário.
Assim, visualizar o menu atualiza o sino imediatamente, reiniciar a aplicação
não restaura notificações já lidas e uma solicitação criada ou reaberta em uma
nova versão depois da leitura volta a aparecer como não lida.

## Suporte por e-mail

`POST /support/requests` exige `support:create`. O corpo contém somente assunto
e mensagem; nome, usuário e e-mail do solicitante são obtidos da identidade
autenticada e incluídos nas versões HTML e texto. O conteúdo fornecido pelo
usuário é escapado antes de compor o HTML e quebras de linha são preservadas.

O envio reutiliza a configuração Resend e possui timeout, retentativas limitadas
e chave de idempotência baseada no identificador da solicitação. O sucesso
retorna o identificador público e o identificador do provedor. Indisponibilidade
de configuração retorna `EMAIL_DELIVERY_UNAVAILABLE`; falha após as tentativas
retorna `SUPPORT_EMAIL_DELIVERY_FAILED`. Os dois erros expõem somente um código
sanitizado, o identificador público e `fallbackAllowed=true`, sem vazar a chave
do provedor, destinatários internos ou conteúdo sensível em logs.

O destinatário principal é definido por `SUPPORT_RECIPIENT_EMAIL`.
`SUPPORT_CC_EMAIL` aceita uma ou mais cópias separadas por vírgulas. A
configuração é validada na inicialização, normaliza duplicatas e evita repetir o
destinatário principal como cópia.

## Intercâmbio temporário de arquivos

O módulo de intercâmbio segue as mesmas camadas da aplicação: catálogo de
capacidades no domínio, caso de uso na aplicação, repositório abstrato,
implementação Prisma e conversores na infraestrutura. O PostgreSQL mantém
metadados, bytes, hash, expiração e auditoria sob `companyId`.

O módulo não substitui os documentos de proposta do WhatsApp, que possuem ciclo
e regras comerciais próprios. Ele é uma fundação reutilizável para futuras
views de importação/exportação. Cache e navegador não armazenam o estado
autoritativo desses artefatos. Consulte [data-exchange.md](data-exchange.md).
