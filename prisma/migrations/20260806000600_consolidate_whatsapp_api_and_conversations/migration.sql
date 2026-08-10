BEGIN;

-- Finaliza execucoes antigas que ainda estavam presas ao provedor removido e
-- devolve os eventos para a fila interna da API sem duplicar o efeito.
DELETE FROM "integration_inbox" AS legacy
USING "integration_inbox" AS current
WHERE legacy."company_id" = current."company_id"
  AND legacy."external_event_id" = current."external_event_id"
  AND legacy."source" IN (
    'n8n.quote-patch',
    'n8n.outbound-command',
    'n8n.evolution-claim',
    'n8n.evolution-result'
  )
  AND current."source" = replace(legacy."source", 'n8n.', 'api.');

UPDATE "integration_inbox"
SET "source" = replace("source", 'n8n.', 'api.')
WHERE "source" IN (
  'n8n.quote-patch',
  'n8n.outbound-command',
  'n8n.evolution-claim',
  'n8n.evolution-result'
);

UPDATE "whatsapp_automation_executions" AS execution
SET
  "status" = 'retryable-failure',
  "completed_at" = CURRENT_TIMESTAMP,
  "error_code" = 'LEGACY_PROVIDER_REMOVED',
  "error_message" = 'Execucao devolvida para processamento pela API.',
  "updated_at" = CURRENT_TIMESTAMP
FROM "integration_outbox" AS event
WHERE execution."outbox_event_id" = event."id"
  AND execution."company_id" = event."company_id"
  AND execution."provider" = 'n8n'
  AND execution."status" IN ('claimed', 'accepted')
  AND event."status" = 'processing';

UPDATE "integration_outbox"
SET
  "status" = 'pending',
  "processing_provider" = NULL,
  "execution_id" = NULL,
  "accepted_at" = NULL,
  "execution_lease_until" = NULL,
  "locked_at" = NULL,
  "lock_id" = NULL,
  "available_at" = CURRENT_TIMESTAMP,
  "last_error" = NULL,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "status" = 'processing'
  AND "processing_provider" = 'n8n';

CREATE TEMP TABLE "_whatsapp_conversation_merge" AS
WITH ranked AS (
  SELECT
    "id" AS "duplicate_id",
    FIRST_VALUE("id") OVER (
      PARTITION BY "company_id", "channel_id", "contact_id"
      ORDER BY ("closed_at" IS NULL) DESC, "updated_at" DESC, "id" DESC
    ) AS "canonical_id",
    COUNT(*) OVER (
      PARTITION BY "company_id", "channel_id", "contact_id"
    ) AS "group_size"
  FROM "whatsapp_conversations"
)
SELECT "duplicate_id", "canonical_id"
FROM ranked
WHERE "group_size" > 1;

-- As duas FKs compostas compartilham conversation_id. Elas sao recriadas
-- depois da consolidacao para permitir a troca atomica dos tres registros.
ALTER TABLE "quote_proposal_documents"
  DROP CONSTRAINT IF EXISTS "quote_proposal_documents_quote_company_conversation_fkey";
ALTER TABLE "quote_proposal_documents"
  DROP CONSTRAINT IF EXISTS "quote_proposal_documents_message_company_conversation_fkey";

UPDATE "whatsapp_messages" AS message
SET "conversation_id" = merge."canonical_id"
FROM "_whatsapp_conversation_merge" AS merge
WHERE message."conversation_id" = merge."duplicate_id"
  AND merge."duplicate_id" <> merge."canonical_id";

CREATE TEMP TABLE "_whatsapp_quote_merge" AS
SELECT
  quote."id",
  merge."canonical_id",
  ROW_NUMBER() OVER (
    PARTITION BY quote."company_id", merge."canonical_id"
    ORDER BY quote."created_at", quote."id"
  )::INTEGER AS "new_sequence",
  (
    MAX(quote."sequence") OVER (
      PARTITION BY quote."company_id", merge."canonical_id"
    )
    + ROW_NUMBER() OVER (
      PARTITION BY quote."company_id", merge."canonical_id"
      ORDER BY quote."created_at", quote."id"
    )
  )::INTEGER AS "temporary_sequence"
FROM "quote_requests" AS quote
JOIN "_whatsapp_conversation_merge" AS merge
  ON merge."duplicate_id" = quote."conversation_id";

UPDATE "quote_requests" AS quote
SET "sequence" = mapped."temporary_sequence"
FROM "_whatsapp_quote_merge" AS mapped
WHERE quote."id" = mapped."id";

UPDATE "quote_requests" AS quote
SET
  "conversation_id" = mapped."canonical_id",
  "sequence" = mapped."new_sequence"
FROM "_whatsapp_quote_merge" AS mapped
WHERE quote."id" = mapped."id";

UPDATE "quote_proposal_documents" AS document
SET "conversation_id" = merge."canonical_id"
FROM "_whatsapp_conversation_merge" AS merge
WHERE document."conversation_id" = merge."duplicate_id";

ALTER TABLE "whatsapp_conversation_transitions"
  DISABLE TRIGGER "whatsapp_transitions_append_only";

UPDATE "whatsapp_conversation_transitions" AS transition
SET "conversation_id" = merge."canonical_id"
FROM "_whatsapp_conversation_merge" AS merge
WHERE transition."conversation_id" = merge."duplicate_id"
  AND merge."duplicate_id" <> merge."canonical_id";

ALTER TABLE "whatsapp_conversation_transitions"
  ENABLE TRIGGER "whatsapp_transitions_append_only";

UPDATE "whatsapp_import_records" AS record
SET "conversation_id" = merge."canonical_id"
FROM "_whatsapp_conversation_merge" AS merge
WHERE record."conversation_id" = merge."duplicate_id"
  AND merge."duplicate_id" <> merge."canonical_id";

CREATE TEMP TABLE "_whatsapp_outbox_merge" AS
SELECT
  event."id",
  merge."canonical_id",
  ROW_NUMBER() OVER (
    PARTITION BY event."company_id", event."aggregate_type", merge."canonical_id"
    ORDER BY event."created_at", event."id"
  )::INTEGER AS "new_sequence",
  (
    MAX(event."aggregate_sequence") OVER (
      PARTITION BY event."company_id", event."aggregate_type", merge."canonical_id"
    )
    + ROW_NUMBER() OVER (
      PARTITION BY event."company_id", event."aggregate_type", merge."canonical_id"
      ORDER BY event."created_at", event."id"
    )
  )::INTEGER AS "temporary_sequence"
FROM "integration_outbox" AS event
JOIN "_whatsapp_conversation_merge" AS merge
  ON event."aggregate_type" = 'whatsapp-conversation'
 AND event."aggregate_id" = merge."duplicate_id"::text;

UPDATE "integration_outbox" AS event
SET "aggregate_sequence" = mapped."temporary_sequence"
FROM "_whatsapp_outbox_merge" AS mapped
WHERE event."id" = mapped."id";

UPDATE "integration_outbox" AS event
SET
  "aggregate_id" = mapped."canonical_id"::text,
  "aggregate_sequence" = mapped."new_sequence",
  "payload" = jsonb_set(
    jsonb_set(
      event."payload",
      '{conversationId}',
      to_jsonb(mapped."canonical_id"::text),
      true
    ),
    '{conversation,id}',
    to_jsonb(mapped."canonical_id"::text),
    true
  )
FROM "_whatsapp_outbox_merge" AS mapped
WHERE event."id" = mapped."id";

DELETE FROM "whatsapp_conversations" AS conversation
USING "_whatsapp_conversation_merge" AS merge
WHERE conversation."id" = merge."duplicate_id"
  AND merge."duplicate_id" <> merge."canonical_id";

UPDATE "whatsapp_conversations"
SET "assigned_to_user_id" = NULL
WHERE "conversation_state" <> 'human-active'
  AND "assigned_to_user_id" IS NOT NULL;

UPDATE "whatsapp_conversations"
SET
  "conversation_state" = 'sent-to-human',
  "flow_step" = 'human-service'
WHERE "conversation_state" = 'human-active'
  AND "assigned_to_user_id" IS NULL;

ALTER TABLE "quote_proposal_documents"
  ADD CONSTRAINT "quote_proposal_documents_quote_company_conversation_fkey"
  FOREIGN KEY ("quote_request_id", "company_id", "conversation_id")
  REFERENCES "quote_requests"("id", "company_id", "conversation_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quote_proposal_documents"
  ADD CONSTRAINT "quote_proposal_documents_message_company_conversation_fkey"
  FOREIGN KEY ("message_id", "company_id", "conversation_id")
  REFERENCES "whatsapp_messages"("id", "company_id", "conversation_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX IF EXISTS "whatsapp_conversations_one_open_per_contact";
DROP INDEX IF EXISTS "whatsapp_conversations_company_id_channel_id_contact_id_clo_idx";

CREATE UNIQUE INDEX "whatsapp_conversations_company_channel_contact_key"
  ON "whatsapp_conversations"("company_id", "channel_id", "contact_id");

ALTER TABLE "whatsapp_conversations"
  ADD CONSTRAINT "whatsapp_conversations_assignee_requires_human_active_check"
  CHECK (
    ("conversation_state" = 'human-active' AND "assigned_to_user_id" IS NOT NULL)
    OR
    ("conversation_state" <> 'human-active' AND "assigned_to_user_id" IS NULL)
  );

DROP TABLE IF EXISTS "_whatsapp_outbox_merge";
DROP TABLE IF EXISTS "_whatsapp_quote_merge";
DROP TABLE IF EXISTS "_whatsapp_conversation_merge";

COMMIT;
