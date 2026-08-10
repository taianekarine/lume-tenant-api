# Operação em produção

## Preparação

1. Copie `.env.production.example` para um gerenciador de segredos.
2. Configure banco, JWT, licença, e-mail, canal WhatsApp, Evolution, o diretório
   persistente `WHATSAPP_MEDIA_STORAGE_PATH` e ao menos um provedor de IA.
3. Use HTTPS para CORS, redefinição de senha e `EVOLUTION_BASE_URL`.
4. Mantenha `SWAGGER_ENABLED=false` salvo durante diagnóstico controlado.
5. Execute `npm ci`, `npm run prisma:deploy`, `npm run build` e `npm test`.

Nunca grave segredos no repositório. A chave da Evolution, o segredo do webhook,
JWTs e chaves de IA permanecem apenas no servidor da Tenant API.

## Publicação

Aplique migrações antes de iniciar a nova versão. A migração de consolidação do
WhatsApp converte marcadores legados, normaliza atendimentos inconsistentes,
unifica conversas duplicadas e cria a chave canônica por empresa, canal e
contato. Faça backup e confira o plano em homologação antes do deploy.

A migração `20260807000100_retain_whatsapp_media_content` adiciona os metadados
da cópia própria. Monte o volume antes de liberar o webhook. Banco e volume de
mídias devem participar da mesma política de backup e restauração.

Suba uma única versão consumidora da outbox. Durante rolling deploy, garanta que
as instâncias usam a mesma versão do contrato e os mesmos limites. O lock no
banco impede execução simultânea do mesmo evento, mas versões divergentes não
devem permanecer ativas por períodos prolongados.

## Evolution e WhatsApp

Configure o webhook oficial para
`POST https://<tenant-api>/api/v1/webhooks/evolution`. A assinatura, tamanho,
idade, canal e identificador externo são validados antes da persistência.

O navegador nunca acessa a Evolution. A API baixa cada mídia durante o webhook,
grava no volume próprio e a rota autenticada aplica autorização da empresa. A
leitura normal usa somente a cópia persistida. Defina
`EVOLUTION_MEDIA_CONTENT_TIMEOUT_MS` acima do timeout esperado da Evolution e
abaixo do timeout do proxy reverso.

`WHATSAPP_MEDIA_STORAGE_PATH` é obrigatório e absoluto em produção. No Compose,
o caminho é `/app/var/whatsapp-media`. Não use a camada gravável efêmera do
container. Monitore espaço livre e erros de escrita; uma falha temporária de
download ou armazenamento deve provocar reentrega do webhook.

Quando `WHATSAPP_ENABLED=true`, a automação própria da API é iniciada. Não há
seletor de consumidor. Não execute outro processo lendo a mesma outbox.

## Verificações pós-deploy

- readiness e login sem mensagem de erro após redirecionamento;
- recebimento repetido do mesmo webhook gera uma única mensagem;
- menu inicial, IA, coleta e encaminhamento funcionam;
- assumir atendimento define responsável e libera o campo de resposta;
- devolver ao bot preserva contexto; encerrar aguarda o próximo contato;
- retorno textual ou por mídia reutiliza a conversa, preserva histórico e
  orçamentos e começa pelo menu inicial;
- envio de texto e PDF muda a fila e os contadores sem recarregar a página;
- imagem, áudio, vídeo, figurinha, documento e PDF abrem no painel antes e
  depois de reiniciar a API;
- desligar temporariamente o acesso à Evolution não afeta mídias já armazenadas;
- conteúdo não textual não avança menus nem coleta da IA e recebe orientação;
- logs e interface não exibem segredos nem detalhes internos ao usuário.

## Recuperação

Se a automação apresentar comportamento incorreto, defina
`WHATSAPP_ENABLED=false`, reinicie a API e preserve banco e outbox para análise.
Corrija a causa e valide um evento sintético antes de reativar. Eventos isolados
só devem ser reabertos depois de confirmar que não foram processados ou enviados.

Restaure banco somente como último recurso e sempre junto da mesma versão das
migrações. Nunca apague mensagens ou conversas para corrigir duplicidade; use a
chave canônica e a trilha de correlação para reconciliar o estado.

Restaure o volume de mídias junto do banco. Para registros históricos ainda sem
cópia própria, use o endpoint autenticado de retenção enquanto a mídia continuar
disponível na Evolution. Arquivos que já expiraram são irrecuperáveis e devem ser
apresentados como indisponíveis, sem substituição silenciosa.
