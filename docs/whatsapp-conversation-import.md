# Importação de atendimentos WhatsApp existentes

O importador é executado exclusivamente pela Tenant API. Ele não carrega o
`AppModule`: a CLI abre somente uma conexão Prisma, portanto não inicializa
dispatcher de outbox, retenção, cache, Evolution API, webhook ou envio de
notificações.

## Importação assistida de históricos exportados

Usuários com `whatsapp-conversations:manage` também podem usar **Painel
WhatsApp > Importar históricos**. A interface aceita vários backups ZIP
individuais exportados pelo WhatsApp e conduz o mesmo contrato oficial abaixo:

1. cada ZIP é validado separadamente e uma falha não cancela os demais;
2. o parser reconhece os formatos Android e iOS, mensagens multilinha, emojis,
   avisos do sistema, mensagens apagadas e referências de mídia;
3. telefone, participante que representa a empresa, departamento e estado
   final são revisados explicitamente antes da carga;
4. é gerada uma única planilha consolidada com as três tabelas oficiais;
5. o botão de aplicar executa `validate` e `apply` do importador existente.

Não há associação por semelhança de nome. O telefone confirmado é a identidade
canônica e dois backups que apontem para o mesmo número são rejeitados no mesmo
lote. O estado final nunca é deduzido arbitrariamente; enquanto houver dado
obrigatório sem revisão, o lote permanece bloqueado para aplicação.

As datas sem fuso no arquivo exportado são interpretadas como horário civil de
`America/Sao_Paulo` e persistidas em UTC. Identificadores de conversa e mensagem
são determinísticos, portanto validar ou aplicar novamente o mesmo conteúdo não
duplica registros.

O ZIP é mantido em armazenamento privado somente durante a preparação do lote.
O Compose monta `lume_tenant_whatsapp_imports` em
`/app/var/imports/whatsapp`; inclua esse volume na rotina de limpeza e backup.
Rascunhos expiram após `WHATSAPP_HISTORY_IMPORT_RETENTION_HOURS`.

Imagens, áudios, vídeos, figurinhas, contatos e documentos presentes no ZIP são
copiados para o armazenamento durável de mídias e vinculados à mensagem
importada. Assim, a visualização autenticada usa a cópia própria da aplicação e
continua disponível depois que o lote temporário expira. Arquivos citados no
texto, mas ausentes do ZIP, são sinalizados para conferência e nunca simulados
como recuperáveis.

Aplicar novamente um lote ou combinar uma conversa já importada com novas
conversas é idempotente: as mensagens já confirmadas são reconhecidas por seus
identificadores determinísticos, não invalidam o restante do lote e não são
duplicadas.

## Backup Android completo (`msgstore.db.crypt15`)

O modo **Backup Android completo** recebe um único banco e importa em lote as
conversas individuais. A chave deve possuir 64 caracteres hexadecimais, é usada
somente para derivar a chave AES-GCM da requisição e nunca é escrita no
manifesto, banco de dados, log ou Git.

Antes da confirmação, a API autentica o arquivo, descompacta com limite de
bytes, executa `PRAGMA quick_check` e apresenta totais de conversas, mensagens,
mídias pendentes e itens excluídos. A situação final e o departamento são
escolhidos explicitamente. A aplicação ocorre em segundo plano, em blocos
determinísticos, e pode ser retomada sem duplicar mensagens.

Por padrão, cada bloco contém até 10.000 mensagens e quatro conversas
independentes são aplicadas em paralelo. Os valores podem ser ajustados por
`WHATSAPP_ANDROID_IMPORT_CHUNK_MESSAGES` e
`WHATSAPP_IMPORT_APPLY_CONCURRENCY` (máximo 8), conforme a capacidade do banco
de dados da instalação.

O banco guarda referências de mídia, mas não fotos, áudios, vídeos e documentos
reproduzíveis. Enquanto a pasta `Media` não for carregada, essas mensagens são
visíveis no histórico com mídia indisponível; a vinculação dos arquivos é uma
etapa independente e idempotente.

A tela apresenta a etapa **Vincular mídias** após concluir as mensagens. Nela é
possível selecionar um ZIP contendo `WhatsApp/Media` ou
`WhatsApp Business/Media`. O navegador envia o arquivo em blocos retomáveis de
16 MiB; uma interrupção pode ser retomada selecionando o mesmo arquivo. Ao fim
do envio, a API lê o diretório do ZIP como stream e vincula somente os arquivos
citados no banco, sem manter o ZIP inteiro nem todos os arquivos descompactados
na memória. O processamento continua em segundo plano e seu progresso pode ser
acompanhado na própria tela mesmo depois de sair e retornar à página.

Os limites padrão desse fluxo são 8 GiB por ZIP, 250.000 entradas e 16 GiB
descompactados. Eles podem ser ajustados por
`WHATSAPP_ANDROID_MEDIA_ARCHIVE_MAX_BYTES`,
`WHATSAPP_ANDROID_MEDIA_ARCHIVE_MAX_ENTRIES` e
`WHATSAPP_ANDROID_MEDIA_ARCHIVE_MAX_UNCOMPRESSED_BYTES`. O tamanho do bloco é
configurado por `WHATSAPP_ANDROID_MEDIA_UPLOAD_CHUNK_BYTES`. O volume
`lume_tenant_whatsapp_imports` precisa ter espaço para o ZIP durante o envio e o
processamento; a cópia temporária é removida quando a vinculação termina.

Telefones móveis brasileiros antigos sem o nono dígito são normalizados para
a mesma identidade usada pela agenda. Assim, nomes importados por CSV também
aparecem nas conversas históricas que ainda tenham sido gravadas com a forma
antiga do número.

`Backups.zip` não é um arquivo de mídias: ele contém bancos auxiliares
criptografados do Android. Para dezenas de milhares de arquivos, também é
possível copiar a pasta `Media` para um volume privado da VPS com `rsync` e
executar, dentro do diretório da Tenant API:

```bash
npm run whatsapp:android-media:attach:prod -- \
  --company-id <UUID_DO_TENANT> \
  --batch-id <UUID_DO_LOTE_DA_TELA> \
  --media-root /caminho/privado/WhatsApp\ Business/Media \
  --confirm ATTACH:<UUID_DO_LOTE_DA_TELA>
```

O comando considera somente mensagens criadas pelos blocos daquele lote,
ignora links simbólicos, limita o tamanho individual, usa caminho relativo e
somente recorre ao nome do arquivo quando ele é único. Cada binário recebe
SHA-256 e uma chave privada por tenant/conversa/mensagem. Reexecutar o mesmo
comando ignora mídias já armazenadas e tenta novamente apenas as pendentes.

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

- 128 MiB para a planilha e 10 MiB para cada PDF de proposta;
- 100 MiB de PDFs por pacote e no máximo 20 PDFs por conversa;
- 1 GiB descompactado e no máximo 10.000 entradas na planilha XLSX;
- 10.000 atendimentos, 500.000 mensagens e 50.000 documentos na planilha;
- na importação assistida, até 5.000 backups, 512 MiB por ZIP, 5.000 entradas,
  2 GiB descompactados e 128 MiB para o arquivo de conversa;
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
