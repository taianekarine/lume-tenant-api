# WhatsApp consolidado na Tenant API

## Responsabilidades

A Tenant API é a única responsável pelo fluxo de WhatsApp. O módulo concentra:

- recebimento autenticado dos webhooks da Evolution;
- deduplicação, persistência e ordenação de eventos;
- conversa canônica por empresa, canal e número;
- mensagens, anexos, histórico e estado do atendimento;
- menus, automação comercial e integração com IA;
- envio de mensagens e propostas em PDF pela Evolution;
- recuperação autenticada de imagens, áudios, vídeos, figurinhas e documentos.

O Tenant Web consome somente os endpoints autenticados da Tenant API. Segredos
da Evolution e dos provedores de IA permanecem no servidor.

## Importação de históricos

O subfluxo `whatsapp/history-imports` recebe backups ZIP exportados pelo
WhatsApp ou um `msgstore.db.crypt15` completo do Android, mantém um manifesto
privado por empresa e reutiliza o contrato do importador oficial. Todas as rotas exigem
`whatsapp-conversations:manage`:

- `GET /channels`: canais disponíveis no tenant;
- `POST /`: inicia um lote idempotente por `commandId`;
- `GET /:batchId`: consulta totais, erros e revisões;
- `POST /:batchId/archives`: valida um ZIP por vez;
- `POST /:batchId/android-backup`: recebe o `msgstore.db.crypt15`, a chave
  hexadecimal e a situação/departamento confirmados pelo operador;
- `PATCH /:batchId/archives/:archiveId`: confirma identidade e estado;
- `GET /:batchId/workbook`: baixa a planilha consolidada;
- `POST /:batchId/apply`: valida e aplica pelo importador existente.

No modo Android, a chave permanece somente na memória da requisição e é
descartada após a descriptografia autenticada. O SQLite é validado antes de ser
aceito e processado assincronamente em blocos idempotentes de até 5.000
mensagens. Conversas individuais com JID telefônico são consolidadas; grupos,
listas, status e chats técnicos são contabilizados e excluídos porque o modelo
atual do painel é orientado a atendimentos individuais.

O lote não dispara respostas, IA, menus ou outbox. Depois da aplicação, as
conversas passam a usar exatamente as mesmas entidades, transições e regras do
fluxo corrente. Anexos realmente contidos no ZIP são retidos no volume próprio
de mídias; referências ausentes permanecem identificadas como indisponíveis.
O `msgstore` não contém os binários das mídias: caminhos de imagens, áudios,
vídeos e documentos são preservados como pendentes para uma carga posterior.

Uploads grandes também precisam ser liberados no proxy reverso da VPS. Para um
backup de 454 MB, configure o equivalente a `client_max_body_size 2g` e um
timeout de leitura superior ao tempo do upload. O volume de importação deve ter
espaço para o arquivo criptografado temporário, o SQLite descriptografado e os
blocos XLSX; recomenda-se pelo menos três vezes o tamanho do banco aberto.

## Garantias de processamento

Cada webhook usa o identificador externo e o hash do conteúdo para deduplicação.
Os eventos internos são gravados em outbox ordenada por conversa e processados
pela própria API com lease, tentativas e backoff. Apenas uma execução ativa pode
tratar cada evento. O provedor registrado nas novas execuções é sempre `api`.

Em `messages.upsert`, `data.key.fromMe=false` é entrada do cliente e pode gerar
automação conforme o estado da conversa. `fromMe=true` é uma saída já enviada
pelo WhatsApp App, Web ou outro dispositivo conectado: ela é persistida como
`outbound/sent`, mas nunca cria outbox inbound, não aumenta não lidas e não muda
o estado do atendimento. O contato é resolvido pelo JID telefônico em
`remoteJid` ou `remoteJidAlt`; um `remoteJid` terminado em `@lid` só é aceito
quando o payload também contém a identidade telefônica alternativa. O
`participant` é validado, mas não substitui o contato de uma conversa direta.

Quando a mensagem já foi criada pelo painel, o mesmo `providerMessageId`
retornado pela Evolution identifica o eco do webhook e o registro existente é
reutilizado. Reentregas posteriores continuam idempotentes.

A migração `20260806000600_consolidate_whatsapp_api_and_conversations` converte
marcadores legados, devolve execuções interrompidas para processamento seguro e
consolida conversas duplicadas antes de criar a chave única canônica.

## Conversa e atendimento

A listagem autenticada de conversas é sempre paginada e aceita pesquisa e
filtros de departamento, condução e situação comercial. A resposta inclui um
resumo agregado da seleção, portanto o painel não precisa percorrer todas as
páginas para calcular os indicadores. Esse contrato evita rajadas de centenas
de requisições depois da importação de um histórico grande.

Existe uma conversa canônica para cada combinação de empresa, canal e contato.
Encerrar atendimento finaliza somente a sessão humana atual: remove o atendente
e preserva mensagens, anexos e orçamentos. A conversa permanece encerrada até o
próximo contato. A primeira mensagem seguinte, textual ou não, reabre a mesma
conversa, registra `reopen-after-customer-message` e apresenta o menu inicial
antes de qualquer interpretação do conteúdo.

Devolver ao bot remove o atendente, mas preserva o contexto comercial para que o
fluxo retome do ponto adequado. Uma conversa em `human-active` sempre possui um
atendente; qualquer estado legado incompatível é normalizado pela migração.

O envio humano de uma proposta em PDF assume o usuário remetente como atendente
ativo antes de enfileirar o documento e registra a transição no histórico.
O mesmo compositor autenticado pode enviar texto, imagem, áudio, vídeo,
documento ou contato por
`POST /api/v1/whatsapp/conversations/:conversationId/media-messages`. O arquivo
é armazenado antes de entrar na outbox e é removido se a persistência da
mensagem falhar.

## Conteúdo de mídia

O painel nunca recebe a chave nem a URL temporária da Evolution. No recebimento
do webhook, a API persiste a mensagem de entrada ou saída e baixa o binário
enquanto ele ainda está disponível. Depois valida MIME, compatibilidade com o
tipo e limite de tamanho e grava
o conteúdo no armazenamento controlado. O banco mantém somente a chave interna,
MIME, tamanho real, nome normalizado, SHA-256 e data do armazenamento. Uma nova
tentativa do mesmo evento reutiliza a mensagem e a chave existentes, sem criar
duplicidade.

O limite funcional padrão é 50 MiB (`WHATSAPP_MAX_ATTACHMENT_BYTES=52428800`).
Uma mídia acima desse valor não desaparece: a mensagem permanece no histórico
com `retentionStatus=too-large`, enquanto o conteúdo não é baixado nem armazenado.

A implementação atual usa `filesystem`. Em produção,
`WHATSAPP_MEDIA_STORAGE_PATH` deve apontar para um diretório absoluto montado em
volume persistente e incluído no backup. O `compose.prod.yml` monta o volume
`lume_tenant_whatsapp_media` em `/app/var/whatsapp-media`.

A rota autenticada
`GET /api/v1/whatsapp/conversations/:conversationId/messages/:messageId/content`
valida empresa, permissão, conversa e mensagem e serve primeiro a cópia própria,
sem consultar a Evolution. PDFs de propostas enviadas continuam sendo lidos do
banco. A resposta usa `private, no-store` e `nosniff`.

Para uma mídia histórica sem cópia própria, a primeira leitura tenta uma única
recuperação segura e a armazena. Um usuário com permissão de gerenciamento também
pode solicitar o reprocessamento idempotente por
`POST /api/v1/whatsapp/conversations/:conversationId/messages/:messageId/content/retain`.
Se a origem já expirou, a API responde claramente que o arquivo não está mais
disponível; nenhuma recuperação inexistente é prometida.

Falhas temporárias de rede ou do provedor retornam indisponibilidade de serviço,
permitindo nova entrega do webhook. Respostas definitivas de arquivo inexistente
não geram repetição infinita.

## Entrada não textual

Imagem, áudio, vídeo, figurinha, documento, localização, contato ou conteúdo
desconhecido são bloqueados antes dos menus e da IA. A conversa não muda de
etapa, o conteúdo não é interpretado como resposta e o cliente recebe:

> Ainda não consigo interpretar esse tipo de arquivo. Por favor, envie sua resposta em texto.

Durante a coleta de orçamento, a pergunta textual pendente é repetida antes da
orientação. A mesma regra vale no menu inicial e no menu comercial. Durante
atendimento humano, a entrada continua persistida e visível, mas o bot permanece
em silêncio absoluto. Na reabertura de uma conversa encerrada, o menu inicial
aparece primeiro.

## Configuração mínima

Quando `WHATSAPP_ENABLED=true`, configure:

- canal, número e limites `WHATSAPP_*`;
- diretório persistente `WHATSAPP_MEDIA_STORAGE_PATH` em produção;
- `EVOLUTION_BASE_URL`, instância, chave e segredo do webhook;
- ao menos uma chave listada em `WHATSAPP_AI_PROVIDER_ORDER`;
- telefones `MILENIUM_DEPARTMENT_*_PHONE` usados pelos menus.

Não existe seletor de provedor de automação. Os arquivos `.env.example` e
`.env.production.example` são a referência vigente.

## Checklist operacional

Antes da publicação, confirme:

1. migrações aplicadas, chave única das conversas criada e volume de mídia montado;
2. webhook válido recebido uma única vez, inclusive após reenvio;
3. menu inicial, coleta por IA e encaminhamento funcionando;
4. assumir, responder, devolver ao bot e encerrar registrados no histórico;
5. envio de texto e de proposta PDF refletido imediatamente no painel;
6. imagem, áudio, vídeo, figurinha, documento e PDF abertos pelo proxy seguro;
7. a mesma mídia continua abrindo após reiniciar a API e sem acesso à URL externa;
8. mídia antiga expirada apresenta estado indisponível e mídia ainda válida é migrada;
9. anexos em cada etapa não avançam o fluxo nem são enviados à IA;
10. falha temporária da Evolution é reprocessada sem mensagem ou evento duplicado.

## Recuperação

Em falha, desative temporariamente `WHATSAPP_ENABLED`, preserve o banco e corrija
a causa antes de reativar. Não execute dois consumidores sobre a mesma outbox.
Eventos com tentativas esgotadas devem ser analisados por correlação e reabertos
somente após confirmar que não foram enviados ou processados.

Banco e volume `WHATSAPP_MEDIA_STORAGE_PATH` formam um único conjunto de backup.
Restaurar apenas um deles pode deixar metadados sem arquivo ou arquivos órfãos.
