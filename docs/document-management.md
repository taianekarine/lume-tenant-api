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
RH e DP podem manter o perfil documental (cargo, estado civil, decisão sobre
documento militar e dependentes), mas essa autorização não permite alterar os
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
cônjuge, dependentes, decisão militar e cargo. A CNH permanece um único item;
para motorista, seu snapshot acrescenta categoria D, EAR e validade. As três
listas antigas continuam disponíveis somente para preservar solicitações já
materializadas.

## Endpoints

Prefixo `/api/v1/document-management`:

- `GET|POST /document-types`;
- `GET|POST /checklists`;
- `GET|POST /requests` e `GET /requests/:id`;
- `GET /requests/:id/history`;
- `POST /requests/:id/items` (inclusão manual);
- `POST /items/:id/policy` (obrigatório, opcional ou dispensado, com motivo);
- `POST /items/:id/submissions` (multipart);
- `POST /submissions/:id/complete`;
- `POST /submissions/:id/reviews`;
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

Para habilitar OpenAI, defina `DOCUMENT_REVIEW_ENABLED=true`,
`DOCUMENT_REVIEW_PROVIDER=openai` e `OPENAI_API_KEY` no ambiente da API. Sem
essas variáveis o fluxo continua pelo validador estrutural local.

O bootstrap pode ser repetido e cria somente registros iniciais ausentes.
