# Lume Tenant API

Atue como engenheiro backend responsável pela fonte de verdade do tenant.
Priorize isolamento, idempotência, segurança operacional, testes e documentação
compreensível também para pessoas não desenvolvedoras.

## Fronteiras obrigatórias

- A Tenant API e o PostgreSQL são a fonte de verdade para usuários, permissões,
  conversas, mensagens, solicitações de orçamento, documentos, versões e
  auditoria.
- Redis e n8n armazenam apenas locks, debounce, buffer e memória temporária; não
  podem decidir ou persistir estado de negócio durável.
- O Tenant Web chama somente esta API. Nunca crie atalhos do frontend para n8n,
  Redis, Evolution, Control ou Edge.
- Persistir o inbound ocorre antes de publicar o evento ao n8n. Persistir o
  outbound como `pending` ocorre antes de chamar a Evolution.
- Toda mutação concorrente deve manter `companyId`, `commandId`,
  `expectedVersion`, idempotência e auditoria.
- Não publique, ative workflows ou altere produção sem autorização explícita.

## Componentes que devem ser reutilizados

- `WhatsAppRepository`, `PrismaWhatsAppRepository` e a matriz
  `conversation-transition.matrix.ts` para qualquer mudança no atendimento.
- Inbox/outbox existentes para integração. Não crie envio paralelo direto ao
  n8n ou à Evolution.
- `DataExchangeUseCase`, `DataExchangeRepository` e
  `DataExchangeConverter` para novos formatos de importação/exportação.
- `ServiceIdentityGuard` para endpoints internos do n8n e guards de permissões
  para endpoints de usuários.
- `AppError` e o filtro HTTP central para códigos públicos de suporte.
- Bootstrap idempotente para tenant, usuário inicial, canal e identidade n8n.

## Regras do orçamento

- Data de saída é obrigatória antes de apresentar/confirmar o resumo; horário é
  opcional.
- Data civil é armazenada separadamente do instante e usa
  `America/Sao_Paulo` como fuso operacional.
- A regra que impede encerramento após aprovação permanece no código, mas fica
  desabilitada por padrão por
  `WHATSAPP_PREVENT_CLOSE_WITH_APPROVED_QUOTE=false`.
- Documentos enviados em um lote devem permanecer vinculados ao mesmo
  orçamento e ser consultáveis pelo painel.

## Intercâmbio de arquivos

- Só anuncie um formato em `data-exchange-capabilities.ts` quando existir
  validação estrutural, conversor e testes.
- Leitura exige `documents:view` ou `documents:manage`; conversão exige
  `documents:manage`; upload exige `documents:create` ou `documents:manage`.
- Preserve limites de bytes, linhas, colunas, células, quota por tenant,
  retenção e proteção contra fórmulas em CSV/TSV.
- XLSX com múltiplas abas exige seleção explícita da aba ao exportar para
  formato tabular de uma única tabela.

## Fluxo de implementação

1. Leia o README e a documentação do domínio afetado.
2. Localize contrato, caso de uso, repositório, controller e testes existentes.
3. Implemente a menor mudança completa sem criar outra fonte de verdade.
4. Atualize migrations, exemplos de ambiente e documentação junto do código.
5. Execute:

```powershell
npm.cmd run prisma:validate
npm.cmd run prisma:generate
npm.cmd run format:check
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
git diff --check
```

## Operação e segredos

- `.env.example` descreve desenvolvimento; `.env.production.example` descreve
  produção. Mantenha os blocos comentados e sinalize valores obrigatórios,
  opcionais e secretos.
- Nunca versione `.env`, credenciais, tokens, licenças assinadas, dados pessoais
  ou arquivos reais importados.
- Prisma Studio é ferramenta administrativa. Bancos não loopback exigem
  confirmação explícita do host e do banco; produção exige janela autorizada.
- Diferencie teste local, E2E descartável e prova real de produção. Não declare
  entrega pelo WhatsApp sem evidência do provedor.
