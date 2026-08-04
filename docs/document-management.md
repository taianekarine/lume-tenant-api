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

## OCR e processamento assíncrono

A instalação atual não possui provedor OCR/IA documental aprovado, scanner
antimalware ou fila genérica. O adaptador `local-structural` executa verificações
determinísticas, registra a ausência de OCR/IA e exige revisão manual. A tabela
`document_validations` preserva provedor, versão, tentativas, alertas, confiança
e campos extraídos para um worker futuro aprovado.

Não conecte serviço externo sem avaliação de LGPD, retenção, região, segredos,
observabilidade, idempotência e reprocessamento.

## Catálogo inicial

`tenant:bootstrap` executa seed idempotente com tipos e checklists geral,
administrativo e motorista. A certidão “federal (estadual)” permanece
condicional e marcada para validação de RH/DP. Motorista exige conferência dos
originais.

## Endpoints

Prefixo `/api/v1/document-management`:

- `GET|POST /document-types`;
- `GET|POST /checklists`;
- `GET|POST /requests` e `GET /requests/:id`;
- `GET /requests/:id/history`;
- `POST /items/:id/submissions` (multipart);
- `POST /submissions/:id/complete`;
- `POST /submissions/:id/reviews`;
- `GET /files/:id/content`;
- `GET /expiring`;
- `POST /items/:id/renewal`;
- `GET /export.xlsx`.

Criação, envio e revisão recebem `commandId`. Atualizações concorrentes de itens
usam a versão persistida.

## Operação

```powershell
npm.cmd run prisma:deploy
npm.cmd run tenant:bootstrap
```

O bootstrap pode ser repetido e cria somente registros iniciais ausentes.
