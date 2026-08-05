UPDATE "document_checklist_items" AS item
SET
  "config_overrides" = item."config_overrides" || '{"repeatableByDependent": true}'::jsonb,
  "updated_at" = CURRENT_TIMESTAMP
FROM "document_types" AS document_type
WHERE item."document_type_id" = document_type."id"
  AND item."company_id" = document_type."company_id"
  AND document_type."code" IN (
    'child-birth-certificate',
    'child-vaccination-card',
    'child-school-statement',
    'child-identification'
  );

UPDATE "document_request_items" AS item
SET
  "config_snapshot" = item."config_snapshot" || '{"repeatableByDependent": true}'::jsonb,
  "updated_at" = CURRENT_TIMESTAMP
FROM "document_types" AS document_type
WHERE item."document_type_id" = document_type."id"
  AND item."company_id" = document_type."company_id"
  AND document_type."code" IN (
    'child-birth-certificate',
    'child-vaccination-card',
    'child-school-statement',
    'child-identification'
  );
