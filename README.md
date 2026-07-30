# Lume Tenant API

Data plane autônomo da plataforma Lume. Cada cliente executa sua própria
instalação, seu próprio PostgreSQL e seus próprios backups.

## Responsabilidades

- autenticação local;
- usuários internos;
- departamentos e permissões individuais;
- sessões e refresh tokens;
- auditoria local;
- outbox/inbox para sincronização tolerante a falhas;
- validação offline da licença;
- contrato de comunicação idempotente com o `lume-edge-agent`.
- backend oficial de WhatsApp com Evolution API e n8n;
- conversas, mensagens, solicitações e transições isoladas por tenant;
- inbox/outbox confiáveis, concorrência otimista e retenção configurável.

O projeto não possui master global, operadores da fornecedora ou cadastro de
outros tenants. Uma instalação aceita exatamente um tenant.

O `lume-edge-agent` é mantido em repositório separado e executado na mesma rede
privada do cliente. O contrato de comandos, eventos e assinatura HMAC está em
[`docs/edge-contract.md`](docs/edge-contract.md).

## Inicialização

O `lume-control` entrega:

- `INSTALLATION_ID`;
- `LICENSE_PUBLIC_KEY_BASE64`;
- `LICENSE_DOCUMENT`.

Depois:

```powershell
Copy-Item .env.example .env
npm.cmd install
docker compose up -d
npm.cmd run prisma:deploy
npm.cmd run tenant:bootstrap
npm.cmd run start:dev
```

Preencha no `.env` com os dados do tenant e do primeiro administrador antes do
bootstrap. Remova `TENANT_ADMIN_PASSWORD` do ambiente depois da criação.

A API usa `http://localhost:3333/api/v1`. O Swagger local fica em
`http://localhost:3333/docs`.

Para habilitar WhatsApp, preencha o bloco `WHATSAPP_*`, `EVOLUTION_*` e `N8N_*`
do ambiente antes de executar o bootstrap idempotente. O contrato completo,
matriz de estados, assinaturas e endpoints está em
[`docs/whatsapp-mvp.md`](docs/whatsapp-mvp.md).

## Autonomia

Login, usuários, permissões, banco, licença e integrações locais não consultam
o `lume-control`. A queda do computador da fornecedora não interrompe o
cliente.

A licença assinada possui validade e tolerância locais. O endpoint autenticado
`GET /api/v1/license/status` mostra o estado sem realizar chamadas externas e
exige simultaneamente o departamento Gerência (`management`) e a permissão
`license:view`.

O vínculo público de acesso é composto por um ou mais departamentos e por
`permissionCodes` selecionadas individualmente. As permissões efetivas nunca
ultrapassam o teto da união desses departamentos. Não existem cargos, papéis ou
relações indiretas de autorização no domínio, no contrato HTTP ou no schema
atual. Assim, um usuário apenas Comercial não recebe acesso administrativo, e
um usuário apenas Gerência não recebe acesso aos fluxos comerciais.
`isAdministrator=true` é uma autoridade explícita e separada: somente outro
administrador pode concedê-la ou removê-la, e ela apresenta todos os
departamentos e permissões do catálogo atual.

O bootstrap idempotente sincroniza as nove áreas operacionais: Comercial,
Compras, Controladoria, Departamento Pessoal, Financeiro, Gerência, Manutenção,
Monitoramento e Operacional. A conta administrativa inicial é vinculada à
autoridade administrativa explícita; seus vínculos diretos ficam vazios para
não confundir administração global com o departamento Gerência.

## Contas e acesso

- `POST /api/v1/auth/password/forgot` recebe usuário ou e-mail e sempre
  responde de forma genérica, sem revelar se a conta existe; em produção o
  Resend é obrigatório, e indisponibilidade de configuração retorna HTTP 503
  antes de consultar o identificador;
- `POST /api/v1/auth/password/change` consome o token opaco, expirável e de uso
  único enviado pelo provedor configurado;
- a senha inicial definida pelo administrador nunca cria sessão; o login
  retorna `ACCOUNT_PASSWORD_SETUP_REQUIRED` com um desafio opaco de primeiro
  acesso para troca imediata, sem depender do fluxo de recuperação por e-mail;
- usuários podem estar `active`, `inactive` ou `suspended`; suspensões revogam
  sessões e expiram automaticamente na data registrada;
- `GET /api/v1/users` aceita paginação, pesquisa e filtros por departamento,
  permissão e status;
- `users:update` altera dados, departamentos, permissões e solicita recuperação
  de senha; `users:manage` fica restrito ao ciclo de estado da conta
  (ativar novamente, desativar ou suspender);
- `users:delete` não faz parte do catálogo nem existe endpoint de exclusão;
- nomes de usuário possuem 3–40 caracteres permitidos e obrigatoriamente ao
  menos uma letra, evitando ambiguidade com documentos;
- `PATCH /api/v1/users/:id/status` ativa, desativa ou suspende por data/dias,
  com motivo obrigatório para suspensão;
- a foto de perfil aceita somente JPEG, PNG ou WebP cuja assinatura corresponda
  ao MIME informado, até 512 KB e entre 128 e 2048 pixels;
- `GET /api/v1/notifications` é autenticado e deriva o resumo somente dos
  departamentos do usuário. No MVP, Comercial recebe a contagem de orçamentos
  pendentes e os demais departamentos recebem uma lista vazia. A leitura é
  persistida por usuário em
  `POST /api/v1/notifications/commercial.pending-quote-proposals/read`; uma nova
  solicitação pendente volta a incrementar o contador não lido;
- `POST /api/v1/support/requests` envia a solicitação pelo Resend e deriva nome,
  usuário e e-mail exclusivamente do JWT. Falhas de configuração ou do provedor
  retornam um código público e `details.fallbackAllowed=true`, permitindo que o
  painel ofereça o aplicativo de e-mail somente como contingência. O destinatário
  é configurado em `SUPPORT_RECIPIENT_EMAIL`; `SUPPORT_CC_EMAIL` aceita múltiplas
  cópias separadas por vírgulas.

## Dados

Os dados permanecem no PostgreSQL do cliente. O banco deve receber backup,
monitoramento e política de retenção próprios. Sessões não devem ser exportadas
em uma migração para outro fornecedor.

### Orçamentos com horário opcional

A data de saída continua obrigatória para apresentar ou confirmar um resumo de
orçamento. O horário pode permanecer vazio e ser informado posteriormente. A
API mantém a data civil separada do instante completo para evitar mudança de dia
por fuso horário; quando houver horário, ambos devem representar o mesmo dia em
`America/Sao_Paulo`.

A mesma regra vale para o cadastro manual feito pelo atendente. Retorno é
opcional, mas nunca pode ser anterior à saída.

O atendente responsável também pode corrigir manualmente o status comercial da
solicitação atual. A API aplica concorrência otimista, limita a alteração ao
orçamento corrente de uma conversa aberta e registra autor, data e motivo na
auditoria. Aprovação ou recusa continuam exigindo uma proposta efetivamente
enviada; cancelamento e recusa exigem motivo.

Ao encerrar um atendimento, a mesma transação persiste uma mensagem de
despedida e sua outbox antes de fechar a conversa. A saudação usa manhã, tarde
ou noite conforme `America/Sao_Paulo`; uma falha ao agendar o envio reverte
também o encerramento.

### Importação, exportação e conversão

O módulo `GET /api/v1/data-exchange/capabilities` publica somente adaptadores
realmente ativos. No MVP:

- PDF é validado e pode gerar outra cópia PDF;
- CSV e TSV podem ser importados como XLSX;
- XLSX pode ser validado ou exportado para CSV/TSV;
- XLSX com várias abas exige `sheetName` na exportação tabular;
- XLS e ODS são reconhecidos, mas recusados até receberem adaptador próprio.

Uploads possuem limite individual, quota temporária por tenant, retenção,
idempotência e auditoria. Arquivos CSV/TSV também possuem limites de linhas,
colunas, células e tamanho de célula. As permissões são distintas: criar permite
upload, visualizar permite consulta/download e gerenciar permite conversão.
Novos formatos devem reutilizar `DataExchangeUseCase`,
`DataExchangeRepository` e `DataExchangeConverter`.

### Prisma Studio

Com o PostgreSQL local em execução:

```powershell
npm.cmd run prisma:studio
```

O navegador pode ser aberto manualmente em `http://localhost:5555`. Bancos fora
de loopback ficam bloqueados. Uma janela administrativa remota exige
`PRISMA_STUDIO_ALLOW_REMOTE=true` e
`PRISMA_STUDIO_CONFIRM_TARGET=host/banco`; produção exige também
`PRISMA_STUDIO_ALLOW_PRODUCTION=true`. Essas flags não devem permanecer
configuradas.

## Qualidade

```powershell
npm.cmd run prisma:validate
npm.cmd run prisma:generate
npm.cmd run format:check
npm.cmd run lint
npm.cmd run test:cov
npm.cmd run build
npm.cmd run prisma:deploy
npm.cmd run test:e2e
docker build --target production -t lume-tenant-api:local .
```

Consulte [architecture.md](docs/architecture.md),
[production.md](docs/production.md), [offboarding.md](docs/offboarding.md),
[edge-contract.md](docs/edge-contract.md) e
[whatsapp-mvp.md](docs/whatsapp-mvp.md). O contrato extensível de arquivos está
em [data-exchange.md](docs/data-exchange.md). A carga silenciosa de atendimentos
WhatsApp atuais por CLI está em
[whatsapp-conversation-import.md](docs/whatsapp-conversation-import.md).
