# Ambientes e branches

## Estado verificado em 11/08/2026

- o repositório possui CI, mas não possui workflow de deploy automático para a VPS;
- `compose.prod.yml` é versionado e contém `postgres`, `migrate` e `api`;
- `compose.vps.yml` existe na VPS como configuração local e não é versionado;
- o comando executado na VPS com `.env.production`, `compose.prod.yml` e
  `compose.vps.yml` apresentou os serviços `postgres`, `migrate` e `api`;
- a branch remota `staging` foi criada a partir da `main` para separar a
  homologação da produção.

Configurações externas ao repositório, como proxy reverso, DNS, certificados,
gatilhos e diretórios reais de staging, precisam ser conferidas diretamente na
VPS antes do primeiro deploy de homologação.

## Regra obrigatória

- staging usa exclusivamente a branch `staging`;
- produção usa exclusivamente a branch `main`;
- uma branch de trabalho nunca é implantada diretamente;
- `staging` só chega à `main` após validação funcional e autorização explícita;
- arquivos `.env*` reais e `compose.vps.yml` permanecem fora do Git.

## Staging

Use um clone e um projeto Compose independentes da produção, por exemplo em
`/home/taiane/lume-staging/lume-tenant-api`. O ambiente deve possuir banco,
volume de mídias, portas, domínio, credenciais e arquivo `.env.staging`
próprios.

```bash
cd /home/taiane/lume-staging/lume-tenant-api
git fetch origin
git switch staging
git pull --ff-only origin staging
test "$(git branch --show-current)" = "staging"
docker compose -p lume-staging \
  --env-file .env.staging \
  -f compose.prod.yml \
  -f compose.vps.yml \
  config --services
docker compose -p lume-staging \
  --env-file .env.staging \
  -f compose.prod.yml \
  -f compose.vps.yml \
  up -d --build
docker compose -p lume-staging \
  --env-file .env.staging \
  -f compose.prod.yml \
  -f compose.vps.yml \
  ps
```

Antes de liberar o teste, confirme o término do serviço `migrate`, a saúde da
API e o endereço de recuperação de senha apontando para o Tenant Web de staging.

## Produção

Depois da aprovação e do merge autorizado de `staging` em `main`:

```bash
cd /home/taiane/lume/lume-tenant-api
git fetch origin
git switch main
git pull --ff-only origin main
test "$(git branch --show-current)" = "main"
docker compose -p lume-production \
  --env-file .env.production \
  -f compose.prod.yml \
  -f compose.vps.yml \
  config --services
docker compose -p lume-production \
  --env-file .env.production \
  -f compose.prod.yml \
  -f compose.vps.yml \
  up -d --build
docker compose -p lume-production \
  --env-file .env.production \
  -f compose.prod.yml \
  -f compose.vps.yml \
  ps
```

Faça backup do banco e do volume de mídias antes das migrações. Valide
`/api/v1/health/ready`, login, recuperação de senha, permissões e os fluxos de
WhatsApp após a publicação.
