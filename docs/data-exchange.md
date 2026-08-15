# Intercâmbio de arquivos

Este módulo prepara a Tenant API para telas genéricas de importação e exportação
sem transferir conversão ou validação para o navegador. A API continua sendo a
autoridade de permissões, isolamento, retenção e auditoria.

O módulo de roteirização possui contratos especializados: modelo/importação de
colaboradores em XLSX e exportações de rota em PDF, XLSX operacional e XLSX/CSV
para Google My Maps. Esses fluxos não usam artefatos temporários genéricos. O
centro de custo não faz parte das exportações do My Maps.

## Endpoints

- `GET /api/v1/data-exchange/capabilities`: formatos e conversões ativos;
- `POST /api/v1/data-exchange/artifacts`: upload multipart de um arquivo;
- `GET /api/v1/data-exchange/artifacts/:id`: metadados;
- `GET /api/v1/data-exchange/artifacts/:id/content`: download;
- `POST /api/v1/data-exchange/artifacts/:id/conversions`: nova conversão.

Upload recebe `file`, `commandId` e `purpose` opcional. Conversão recebe
`commandId`, `targetFormat` e `sheetName` opcional. `sheetName` é obrigatório
quando um XLSX com várias abas for exportado para CSV ou TSV.

## Permissões

| Operação | Permissões aceitas |
| --- | --- |
| Consultar capacidades | `documents:view`, `documents:create` ou `documents:manage` |
| Upload | `documents:create` ou `documents:manage` |
| Metadados/download | `documents:view` ou `documents:manage` |
| Conversão | `documents:manage` |

Consultas sempre incluem `companyId`; um ID de outro tenant deve se comportar
como inexistente.

## Formatos do MVP

| Origem | Destinos ativos |
| --- | --- |
| PDF | PDF |
| XLSX | XLSX, CSV, TSV |
| CSV | XLSX |
| TSV | XLSX |

XLS e ODS são reconhecidos e retornam erro explícito informando que o adaptador
ainda não está disponível. Adicionar apenas a extensão à lista não é
suficiente: cada formato novo precisa de assinatura/MIME, parser, limites,
conversor e testes.

PDF para PDF é uma cópia validada pelos marcadores mínimos do arquivo, não uma
renderização nem um antivírus. Antes de compartilhar arquivos de origem externa
em produção, conecte scanner de malware e um parser PDF estrutural.

## Segurança e limites

- máximo individual: `DATA_EXCHANGE_MAX_FILE_BYTES`;
- quota dos artefatos não expirados por tenant:
  `DATA_EXCHANGE_MAX_TENANT_BYTES`;
- retenção: `DATA_EXCHANGE_RETENTION_DAYS`;
- throttling específico para upload e conversão;
- XLSX passa por preflight do ZIP antes do ExcelJS;
- CSV/TSV possuem limites de linhas, colunas, células e caracteres por célula;
- fórmulas em texto, rich text e hyperlinks são neutralizadas na exportação;
- conversões encadeadas são recusadas para limitar duplicação e retenção;
- cada operação usa `commandId`, fingerprint, auditoria e expiração.

## Reutilização

Uma futura view deve consultar `capabilities`, enviar o arquivo e acompanhar o
artefato. Ela não deve interpretar planilhas localmente. No backend, reutilize:

- `DataExchangeUseCase` para regras e fingerprints;
- `DataExchangeRepository` para persistência isolada;
- `DataExchangeConverter` para adaptadores;
- `data-exchange-capabilities.ts` como catálogo publicado.

## Testes mínimos para um novo adaptador

1. assinatura e MIME válidos/inválidos;
2. limite de tamanho e estrutura;
3. arquivo malformado;
4. isolamento entre tenants;
5. matriz de permissões;
6. idempotência concorrente e expirada;
7. conteúdo perigoso;
8. conversão e download;
9. retenção.
