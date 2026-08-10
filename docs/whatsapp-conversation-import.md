# Importação de atendimentos WhatsApp existentes

O importador é executado exclusivamente pela Tenant API. Ele não carrega o
`AppModule`: a CLI abre somente uma conexão Prisma, portanto não inicializa
dispatcher de outbox, retenção, cache, Evolution API, webhook ou envio de
notificações.

## Diretório privado

O valor padrão é:

```text
var/imports/whatsapp/<nome-do-lote>/
├── modelo-importacao-atendimentos-whatsapp.xlsx
└── files/
    └── proposta.pdf
```

`var/imports/whatsapp/` é ignorado pelo Git. É possível trocar a raiz privada
com `WHATSAPP_IMPORT_ROOT`, mas o pacote, a planilha e todos os PDFs precisam
permanecer dentro dessa raiz resolvida.

Somente as tabelas nomeadas `AtendimentosImportacao`,
`MensagensImportacao` e `DocumentosImportacao` são lidas. As fórmulas de
`validation_status` e `validation_message` nunca são usadas como fonte de
verdade.

## Argumentos

- `--company-id`: UUID do tenant.
- `--channel-id`: UUID do canal WhatsApp do mesmo tenant.
- `--actor-username`: usuário ativo do tenant que responde pela migração e é
  usado como `uploadedByUserId` quando o legado não possui autor do PDF.
- `--batch-name`: nome operacional único no tenant.
- `--package`: diretório do lote; alternativamente use `--workbook` para a
  planilha dentro do lote.
- `--batch-id`: UUID imutável do lote, obrigatório no apply, reconcile e
  rollback.
- `--cutoff-at`: instante ISO-8601 em UTC terminado em `Z`.
- `--confirm`: confirmação exata `APPLY:<batch-id>` ou
  `ROLLBACK:<batch-id>`.

O corte limita fatos que já deveriam existir no sistema anterior: última
interação, mensagens, confirmação/decisão comercial e envio de documentos.
Ele não limita a agenda da viagem. `departure_at` e `return_at` podem ser
posteriores ao corte porque um atendimento histórico pode possuir viagem
agendada para depois da migração.

Flags desconhecidas, duplicadas ou incompatíveis com o comando são rejeitadas.
Antes da primeira execução em um ambiente, revise a migração
`20260729000100_whatsapp_legacy_import`, confirme o backup e só então execute
`npm.cmd run prisma:deploy`. A implementação não executa migração nem carga
automaticamente.

## Dry-run

```powershell
npm.cmd run whatsapp:import:validate -- `
  --company-id 00000000-0000-4000-8000-000000000210 `
  --channel-id 00000000-0000-4000-8000-000000000221 `
  --actor-username admin.lume `
  --batch-name legado-2026-07-29 `
  --package "C:\novos projetos\tks-lume\lume-tenant-api\var\imports\whatsapp\legado-2026-07-29" `
  --cutoff-at 2026-07-29T21:00:00.000Z
```

O resultado é JSON, contém `zeroWrites: true` e não inclui bytes dos PDFs. Um
pacote vazio pode ser validado, mas o `apply` exige pelo menos uma linha
`upsert`.

## Apply

Faça backup e execute o dry-run novamente antes do apply:

```powershell
$batchId = "11111111-1111-4111-8111-111111111111"
npm.cmd run whatsapp:import:apply -- `
  --company-id 00000000-0000-4000-8000-000000000210 `
  --channel-id 00000000-0000-4000-8000-000000000221 `
  --actor-username admin.lume `
  --batch-name legado-2026-07-29 `
  --batch-id $batchId `
  --package "C:\novos projetos\tks-lume\lume-tenant-api\var\imports\whatsapp\legado-2026-07-29" `
  --cutoff-at 2026-07-29T21:00:00.000Z `
  --confirm "APPLY:$batchId"
```

Cada conversa é gravada em uma transação serializável própria. O processo é
idempotente por `source_system + external_conversation_id`; mensagens e
documentos usam suas referências externas e hashes. O SHA-256 imutável do
pacote inclui a planilha e o manifesto ordenado dos PDFs; o mesmo `batch-id`
não aceita conteúdo, tenant, canal, corte ou nome diferentes. Um claim com
lease impede dois applies e também impede apply durante rollback. O importador
não cria outbox, tentativas de envio, notificações ou transições de automação.

O pacote representa o estado atual: admite no máximo uma conversa por telefone
em cada lote, mesmo quando as linhas estão fechadas. Na primeira associação de
uma conversa legada a um contato já existente, o nome live do contato é
preservado. Atualizações posteriores só ocorrem por uma referência externa já
conciliada.

## Reconciliação

```powershell
npm.cmd run whatsapp:import:reconcile -- `
  --company-id 00000000-0000-4000-8000-000000000210 `
  --batch-id 11111111-1111-4111-8111-111111111111
```

A reconciliação compara snapshots completos, propriedade das referências,
registros, mensagens, documentos e distribuições por
departamento/estado/status. A contagem global de outbox observada antes e depois
da carga é apenas um indicador de atividade concorrente; a CLI não grava nessa
tabela.

## Rollback

```powershell
$batchId = "11111111-1111-4111-8111-111111111111"
npm.cmd run whatsapp:import:rollback -- `
  --company-id 00000000-0000-4000-8000-000000000210 `
  --batch-id $batchId `
  --actor-username admin.lume `
  --confirm "ROLLBACK:$batchId"
```

O rollback remove apenas recursos criados pelo lote e restaura snapshots dos
registros atualizados. Ele é bloqueado se a conversa recebeu mensagem,
transição, documento ou alteração real depois do horário de corte; nesse caso,
faça reconciliação assistida. Lotes posteriores dependentes devem ser
revertidos primeiro. Claim, locks dos registros e revalidação são feitos dentro
de uma única transação serializável: ou todo o lote é revertido, ou nenhuma
alteração do rollback é confirmada.

## Limites e validações

- 10 MiB para a planilha e para cada PDF;
- 100 MiB de PDFs por pacote e no máximo 20 PDFs por conversa;
- 64 MiB descompactados e no máximo 2.000 entradas ZIP;
- 500 atendimentos, 1.000 mensagens e 500 documentos;
- datas do Excel interpretadas como horário civil de `America/Sao_Paulo` e
  persistidas em UTC;
- datas de saída e retorno podem ser posteriores ao corte; fatos históricos
  posteriores ao corte continuam rejeitados;
- somente PDF `application/pdf`, extensão `.pdf`, assinatura `%PDF-` e SHA-256;
- nenhum caminho absoluto, `..`, symlink, macro, fórmula ou vínculo externo;
- mensagens inbound usam `received`; outbound histórico aceita somente
  `sent`, `delivered`, `read` ou `failed` — `pending` é rejeitado porque a
  importação não cria tentativa de envio;
- somente os nove departamentos publicados:
  `commercial`, `purchasing`, `controlling`, `personnel-department`,
  `financial`, `management`, `maintenance`, `monitoring` e `operations`.
