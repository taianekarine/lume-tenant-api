# Gestão documental

O módulo é genérico e atende admissão, atualização, renovação, regularização,
desligamento e outras solicitações. A solicitação é vinculada ao tenant e ao
`User` titular; não existe uma segunda identidade para candidato ou funcionário.

## Segurança e acesso

- `document-portal` restringe candidatos a documentos próprios, perfil e suporte;
- RH, Departamento Pessoal e Gerência operam terceiros com `documents:manage`;
- revisão exige `documents:approve` e exportação exige `documents:export`;
- consultas combinam `companyId` e identificador; arquivos usam endpoint
  autenticado e `Cache-Control: private, no-store`;
- nome, MIME, assinatura, tamanho, quantidade, frente/verso e páginas são
  validados antes da persistência;
- logs guardam metadados mínimos e hashes, nunca os bytes integrais.

Na administração de usuários, somente contas com `isAdministrator=true`
podem editar departamentos, permissões, estado ou recuperação de acesso. RH e
Departamento Pessoal possuem apenas `users:view` e `users:create`; ao criarem
uma conta, a API exige `documentAccessMode=document-portal`, sem departamento
ou permissão adicional. O administrador completa os acessos posteriormente.
RH e DP podem manter o perfil documental (classificação Administrativo, Geral ou
Motorista, estado civil, decisão sobre documento militar e dependentes), mas essa
autorização não permite alterar os
demais acessos.

## Fluxo

1. tipos definem formatos, limites, validade, frente/verso, original e extração;
2. checklists são versionados e edições não mudam solicitações antigas;
3. a solicitação materializa itens e snapshots das regras;
4. cada reenvio cria nova `DocumentSubmission` sem sobrescrever versões;
5. a conclusão executa pré-validação estrutural e exige revisão humana;
6. somente um revisor autorizado aprova, recusa ou solicita reenvio;
7. documentos aprovados podem registrar validade e originar renovação;
8. `DocumentStatusHistory` e `TenantAuditLog` registram ações e transições.

O titular pode substituir um envio ainda em revisão ou removê-lo para voltar ao
estado `pending-upload`. A remoção é lógica, preserva versões e auditoria. Depois
da aprovação, somente administrador ou operador com `documents:manage` pode
remover o arquivo, sempre informando o motivo.

Solicitações avulsas aceitam vários titulares e vários tipos documentais em um
único comando. Para cada titular, a API reutiliza o dossiê documental original
não cancelado, inclui somente tipos ausentes e reabre o item quando é solicitada
uma atualização de documento já aprovado. Um dossiê novo só é criado quando o
titular ainda não possui nenhum. Extração, revisão, histórico, XLSX e ZIP
continuam individualizados. A operação é atômica: uma falha de validação impede
a alteração parcial do lote. Ao aprovar um documento, exigências abertas do
mesmo tipo que ainda existam em solicitações legadas duplicadas são dispensadas
com referência ao envio aprovado, histórico e recálculo de todos os dossiês
afetados. A migration `20260805000400_reconcile_duplicate_document_requirements`
aplica a mesma conciliação aos dados existentes.

Documentos de cônjuge, dependentes e situação militar são filtrados pelo perfil
de cada titular. Há um item por tipo documental, não uma cópia do item por filho;
o snapshot registra os dependentes elegíveis e o item aceita os vários arquivos
necessários. Carteira de vacinação considera menores de 7 anos e atestado
escolar considera maiores de 7 até 16 anos.

O backend valida a máquina de estados. OCR/IA nunca aprova, recusa ou atualiza o
cadastro oficial automaticamente.

## Agente de revisão documental

`DocumentReviewAgent` abstrai a revisão. O adaptador `local-structural` permanece
como padrão e fallback. Quando habilitado, o adaptador OpenAI usa a Responses API
com imagem/PDF, Structured Outputs, `store=false`, identificador pseudonimizado,
até três tentativas e o modelo configurado em `OPENAI_DOCUMENT_MODEL`.

O resultado contém classificação, qualidade, alertas e dados propostos por campo,
com confiança e origem. Todo resultado termina em revisão humana; o agente nunca
aprova, recusa nem atualiza o cadastro oficial. A chave existe somente na API.

Esta primeira versão executa o agente durante a conclusão do envio. Não foi
introduzida uma fila nova porque o projeto ainda não possui um worker documental
durável; essa evolução deve preservar idempotência e retentativas persistidas.

Não conecte serviço externo sem avaliação de LGPD, retenção, região, segredos,
observabilidade, idempotência e reprocessamento.

## Catálogo inicial

`tenant:bootstrap` executa seed idempotente. Novas admissões usam
`employee-documents-dynamic`: uma base geral sem duplicidades e condições por
cônjuge, dependentes, decisão militar e classificação. A CNH permanece um único item;
para motorista, seu snapshot acrescenta categoria D, EAR e validade. As três
listas antigas continuam disponíveis somente para preservar solicitações já
materializadas.

## Endpoints

Prefixo `/api/v1/document-management`:

- `GET|POST /document-types`;
- `GET|POST /checklists`;
- `GET|POST /requests`, `POST /requests/batch` e `GET /requests/:id`;
- `GET /requests/:id/history`;
- `POST /requests/:id/items` (inclusão manual);
- `POST /items/:id/policy` (obrigatório, opcional ou dispensado, com motivo);
- `POST /items/:id/submissions` (multipart);
- `POST /items/:id/submissions/complete` (multipart; envio e pré-validação em uma única requisição);
- `POST /submissions/:id/complete`;
- `DELETE /submissions/:id` (remoção lógica e auditada);
- `POST /submissions/:id/reviews`;

O endpoint combinado é o contrato preferencial do Tenant Web. O `commandId`
mantém idempotência e um conjunto de arquivos idêntico já aguardando revisão é
reutilizado sem uma nova chamada ao agente. Um arquivo anteriormente recusado
precisa ser substituído antes de uma nova análise.

Solicitações cujo titular foi excluído logicamente não aparecem nas listas de
acompanhamento nem podem ser abertas por URL antiga. A auditoria e os históricos
permanecem preservados no banco.

O pacote ZIP individual contém uma raiz `nome_do_funcionario_AAAA-MM-DD` e,
dentro dela, apenas a pasta `documentos_vN`, com todos os arquivos consolidados
e o `manifesto.json`, sem subpastas por tipo ou por envio.
- `GET /files/:id/content`;
- `GET /expiring`;
- `POST /items/:id/renewal`;
- `GET /users/:id/export.xlsx` e `GET /users/:id/files.zip`.

O XLSX é sempre individual e contém as abas `Dados do funcionário`,
`Documentos`, `Dependentes` e `Histórico`. Não há consolidação global de
funcionários em uma linha por pessoa.

Criação, envio e revisão recebem `commandId`. Atualizações concorrentes de itens
usam a versão persistida.

## Operação

```powershell
npx.cmd prisma migrate deploy
npm.cmd run tenant:bootstrap
```

Para habilitar OpenAI, as três configurações são obrigatórias e independentes:
`DOCUMENT_REVIEW_ENABLED=true`, `DOCUMENT_REVIEW_PROVIDER=openai` e
`OPENAI_API_KEY`. Definir apenas a chave não muda o provedor; se
`DOCUMENT_REVIEW_PROVIDER=local`, o comportamento correto é continuar no
validador estrutural local. Reinicie a API depois de alterar o ambiente.

O bootstrap pode ser repetido e cria somente registros iniciais ausentes.
