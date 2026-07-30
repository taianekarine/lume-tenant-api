INSERT INTO "tenant_departments" (
  "id",
  "company_id",
  "code",
  "name",
  "is_default",
  "created_at",
  "updated_at"
)
SELECT
  md5(company."id"::text || ':' || queue."code")::uuid,
  company."id",
  queue."code"::"DepartmentCode",
  queue."name",
  queue."is_default",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "companies" AS company
CROSS JOIN (
  VALUES
    ('commercial', 'Comercial', true),
    ('purchasing', 'Compras', false),
    ('controlling', 'Controladoria', false),
    ('personnel-department', 'Departamento Pessoal', false),
    ('financial', 'Financeiro', false),
    ('management', 'Gerência', false),
    ('maintenance', 'Manutenção', false),
    ('monitoring', 'Monitoramento', false),
    ('operations', 'Operacional', false)
) AS queue("code", "name", "is_default")
ON CONFLICT ("company_id", "code")
DO UPDATE SET
  "name" = EXCLUDED."name",
  "is_default" = EXCLUDED."is_default",
  "updated_at" = CURRENT_TIMESTAMP;

CREATE INDEX "whatsapp_conversations_company_department_state_updated_idx"
ON "whatsapp_conversations"(
  "company_id",
  "department",
  "conversation_state",
  "updated_at"
);

CREATE INDEX "whatsapp_conversations_company_department_request_updated_idx"
ON "whatsapp_conversations"(
  "company_id",
  "department",
  "request_status",
  "updated_at"
);
