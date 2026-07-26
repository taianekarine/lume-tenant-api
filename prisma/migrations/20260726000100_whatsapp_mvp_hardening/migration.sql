ALTER TABLE "whatsapp_message_attempts"
  ADD COLUMN "dispatch_claim_id" VARCHAR(120),
  ADD COLUMN "dispatch_fingerprint" CHAR(64),
  ADD COLUMN "dispatch_claimed_at" TIMESTAMP(3);

CREATE TYPE "EvolutionDispatchState" AS ENUM
  ('ready', 'leased', 'unknown', 'succeeded', 'failed');

ALTER TABLE "whatsapp_message_attempts"
  ADD COLUMN "dispatch_state" "EvolutionDispatchState" NOT NULL DEFAULT 'ready',
  ADD COLUMN "dispatch_owner_id" UUID,
  ADD COLUMN "dispatch_lease_until" TIMESTAMP(3);

CREATE UNIQUE INDEX "whatsapp_message_attempts_company_id_dispatch_claim_id_key"
  ON "whatsapp_message_attempts"("company_id", "dispatch_claim_id");

ALTER TABLE "quote_requests"
  ADD COLUMN "confirmed_at" TIMESTAMP(3),
  ADD COLUMN "confirmed_summary" JSONB,
  ADD COLUMN "confirmed_version" INTEGER;

ALTER TABLE "quote_requests"
  ADD CONSTRAINT "quote_requests_confirmed_version_positive"
  CHECK ("confirmed_version" IS NULL OR "confirmed_version" > 0);

CREATE UNIQUE INDEX "whatsapp_conversations_one_open_per_contact"
  ON "whatsapp_conversations"("company_id", "channel_id", "contact_id")
  WHERE "closed_at" IS NULL;

ALTER TABLE "whatsapp_conversations"
  ADD COLUMN "resume_flow_step" "FlowStep",
  ADD COLUMN "main_menu_presented_at" TIMESTAMP(3),
  ADD COLUMN "contextual_follow_up_at" TIMESTAMP(3);

ALTER TABLE "whatsapp_messages"
  ADD COLUMN "automation_purpose" VARCHAR(80);

ALTER TABLE "whatsapp_conversation_transitions"
  ADD COLUMN "command_fingerprint" CHAR(64),
  ADD COLUMN "result_snapshot" JSONB;

UPDATE "whatsapp_conversation_transitions"
SET
  "command_fingerprint" =
    md5(concat_ws(':', "conversation_id"::text, "command_id", "name"))
    || md5(concat_ws(':', "expected_version"::text, "actor_type"::text)),
  "result_snapshot" = jsonb_build_object(
    'id', "conversation_id",
    'department', "to_department",
    'conversationState', "to_state",
    'flowStep', "to_flow_step",
    'requestStatus', "to_request_status",
    'version', "resulting_version"
  );

ALTER TABLE "whatsapp_conversation_transitions"
  ALTER COLUMN "command_fingerprint" SET NOT NULL,
  ALTER COLUMN "result_snapshot" SET NOT NULL;

ALTER TABLE "integration_inbox"
  ADD COLUMN "result_snapshot" JSONB;

ALTER TABLE "integration_outbox"
  ADD COLUMN "aggregate_sequence" INTEGER;

ALTER TABLE "integration_outbox"
  ADD COLUMN "execution_id" UUID,
  ADD COLUMN "accepted_at" TIMESTAMP(3),
  ADD COLUMN "execution_lease_until" TIMESTAMP(3);

UPDATE "integration_outbox"
SET "status" = 'pending', "locked_at" = NULL, "lock_id" = NULL
WHERE "status" = 'processing';

WITH sequenced AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "company_id", "aggregate_type", "aggregate_id"
      ORDER BY "created_at", "id"
    ) AS sequence
  FROM "integration_outbox"
)
UPDATE "integration_outbox" AS target
SET "aggregate_sequence" = sequenced.sequence
FROM sequenced
WHERE target."id" = sequenced."id";

ALTER TABLE "integration_outbox"
  ALTER COLUMN "aggregate_sequence" SET NOT NULL;

ALTER TABLE "integration_outbox"
  ADD CONSTRAINT "integration_outbox_execution_lease_consistent"
  CHECK (
    ("status" = 'processing' AND "execution_id" IS NOT NULL)
    OR
    ("status" <> 'processing')
  );

CREATE UNIQUE INDEX "integration_outbox_company_aggregate_sequence_key"
  ON "integration_outbox"(
    "company_id",
    "aggregate_type",
    "aggregate_id",
    "aggregate_sequence"
  );

CREATE INDEX "integration_outbox_aggregate_order_status_idx"
  ON "integration_outbox"(
    "company_id",
    "aggregate_type",
    "aggregate_id",
    "aggregate_sequence",
    "status"
  );

ALTER TABLE "whatsapp_message_attempts"
  ADD CONSTRAINT "whatsapp_message_attempts_dispatch_lease_consistent"
  CHECK (
    ("dispatch_state" = 'leased' AND "dispatch_owner_id" IS NOT NULL AND "dispatch_lease_until" IS NOT NULL)
    OR
    ("dispatch_state" <> 'leased')
  );
