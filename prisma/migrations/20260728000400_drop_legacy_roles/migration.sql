-- O modelo de acesso passa a usar exclusivamente departamentos e permissões
-- diretas. A remoção é intencionalmente destrutiva e deve ser precedida por
-- backup em instalações que ainda tenham dados nestas tabelas.
DROP TABLE IF EXISTS "user_roles";
DROP TABLE IF EXISTS "roles";
