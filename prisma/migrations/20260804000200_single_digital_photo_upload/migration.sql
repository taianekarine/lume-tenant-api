-- Quantidades das listas físicas representam cópias impressas, não uploads digitais.
-- Todos os perfis devem enviar somente um arquivo de foto 3x4.
UPDATE "document_types"
SET
  "min_files" = 1,
  "max_files" = 1,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "code" = 'photo-3x4';

UPDATE "document_checklist_items" AS item
SET
  "config_overrides" =
    (item."config_overrides" - 'expectedCopies') ||
    '{"minFiles": 1, "maxFiles": 1}'::jsonb,
  "updated_at" = CURRENT_TIMESTAMP
FROM "document_types" AS document_type
WHERE item."document_type_id" = document_type."id"
  AND item."company_id" = document_type."company_id"
  AND document_type."code" = 'photo-3x4';

UPDATE "document_request_items" AS item
SET
  "config_snapshot" =
    (item."config_snapshot" - 'expectedCopies') ||
    '{"minFiles": 1, "maxFiles": 1}'::jsonb,
  "updated_at" = CURRENT_TIMESTAMP
FROM "document_types" AS document_type
WHERE item."document_type_id" = document_type."id"
  AND item."company_id" = document_type."company_id"
  AND document_type."code" = 'photo-3x4';
