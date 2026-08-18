-- Backups antigos podem guardar celulares brasileiros sem o nono dígito.
-- Quando ainda não existe a chave atual, promovemos o próprio contato usado
-- pela conversa para o formato canônico.
WITH "legacy_mobile_contacts" AS (
  SELECT
    "legacy"."id",
    "legacy"."company_id",
    substring("legacy"."phone_normalized" FROM 1 FOR 4) ||
      '9' ||
      substring("legacy"."phone_normalized" FROM 5) AS "canonical_phone"
  FROM "whatsapp_contacts" AS "legacy"
  WHERE "legacy"."phone_normalized" ~ '^55[0-9]{2}[6-9][0-9]{7}$'
)
UPDATE "whatsapp_contacts" AS "legacy"
SET
  "phone_normalized" = "candidate"."canonical_phone",
  "phone_display" =
    '(' || substring("candidate"."canonical_phone" FROM 3 FOR 2) || ') ' ||
    substring("candidate"."canonical_phone" FROM 5 FOR 5) || '-' ||
    substring("candidate"."canonical_phone" FROM 10 FOR 4),
  "updated_at" = CURRENT_TIMESTAMP
FROM "legacy_mobile_contacts" AS "candidate"
WHERE "legacy"."id" = "candidate"."id"
  AND NOT EXISTS (
    SELECT 1
    FROM "whatsapp_contacts" AS "canonical"
    WHERE "canonical"."company_id" = "candidate"."company_id"
      AND "canonical"."phone_normalized" = "candidate"."canonical_phone"
  );

-- Se agenda e histórico já criaram registros separados, preservamos as
-- relações históricas e propagamos o nome da agenda para o contato do chat.
WITH "saved_contacts" AS (
  SELECT
    "saved"."company_id",
    "saved"."phone_normalized",
    substring("saved"."phone_normalized" FROM 1 FOR 4) ||
      substring("saved"."phone_normalized" FROM 6) AS "legacy_phone",
    "saved"."display_name",
    "saved"."name_needs_review",
    "saved"."profile_picture_url"
  FROM "whatsapp_contacts" AS "saved"
  WHERE "saved"."is_saved" = true
    AND "saved"."phone_normalized" ~ '^55[0-9]{2}9[0-9]{8}$'
    AND "saved"."display_name" IS NOT NULL
)
UPDATE "whatsapp_contacts" AS "legacy"
SET
  "display_name" = "saved"."display_name",
  "name_needs_review" = "saved"."name_needs_review",
  "profile_picture_url" = COALESCE(
    "legacy"."profile_picture_url",
    "saved"."profile_picture_url"
  ),
  "is_saved" = false,
  "updated_at" = CURRENT_TIMESTAMP
FROM "saved_contacts" AS "saved"
WHERE "legacy"."company_id" = "saved"."company_id"
  AND "legacy"."phone_normalized" = "saved"."legacy_phone";
