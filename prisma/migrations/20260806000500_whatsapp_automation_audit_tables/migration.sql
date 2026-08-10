CREATE TABLE "whatsapp_automation_executions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id" UUID NOT NULL,
  "outbox_event_id" UUID NOT NULL,
  "execution_id" UUID NOT NULL,
  "provider" "WhatsAppAutomationProvider" NOT NULL,
  "status" "WhatsAppAutomationExecutionStatus" NOT NULL DEFAULT 'claimed',
  "attempt_number" INTEGER NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "accepted_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "error_code" VARCHAR(80),
  "error_message" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "whatsapp_automation_executions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_automation_executions_company_id_execution_id_key"
ON "whatsapp_automation_executions"("company_id", "execution_id");

CREATE INDEX "whatsapp_automation_executions_company_id_outbox_event_id_started_at_idx"
ON "whatsapp_automation_executions"("company_id", "outbox_event_id", "started_at");

CREATE INDEX "whatsapp_automation_executions_provider_status_started_at_idx"
ON "whatsapp_automation_executions"("provider", "status", "started_at");

ALTER TABLE "whatsapp_automation_executions"
ADD CONSTRAINT "whatsapp_automation_executions_company_id_fkey"
FOREIGN KEY ("company_id") REFERENCES "companies"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_automation_executions"
ADD CONSTRAINT "whatsapp_automation_executions_outbox_event_id_company_id_fkey"
FOREIGN KEY ("outbox_event_id", "company_id")
REFERENCES "integration_outbox"("id", "company_id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "whatsapp_automation_decisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id" UUID NOT NULL,
  "outbox_event_id" UUID NOT NULL,
  "input_hash" VARCHAR(64) NOT NULL,
  "provider" VARCHAR(20) NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "prompt_version" VARCHAR(40) NOT NULL,
  "ai_attempt" INTEGER NOT NULL,
  "output" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "whatsapp_automation_decisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_automation_decisions_outbox_event_id_company_id_key"
ON "whatsapp_automation_decisions"("outbox_event_id", "company_id");

CREATE INDEX "whatsapp_automation_decisions_company_id_created_at_idx"
ON "whatsapp_automation_decisions"("company_id", "created_at");

ALTER TABLE "whatsapp_automation_decisions"
ADD CONSTRAINT "whatsapp_automation_decisions_company_id_fkey"
FOREIGN KEY ("company_id") REFERENCES "companies"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_automation_decisions"
ADD CONSTRAINT "whatsapp_automation_decisions_outbox_event_id_company_id_fkey"
FOREIGN KEY ("outbox_event_id", "company_id")
REFERENCES "integration_outbox"("id", "company_id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "whatsapp_automation_checkpoints" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id" UUID NOT NULL,
  "outbox_event_id" UUID NOT NULL,
  "input_hash" VARCHAR(64) NOT NULL,
  "conversation_snapshot" JSONB NOT NULL,
  "messages_snapshot" JSONB NOT NULL,
  "buffered_text" TEXT NOT NULL,
  "plan_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "whatsapp_automation_checkpoints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_automation_checkpoints_outbox_event_id_company_id_key"
ON "whatsapp_automation_checkpoints"("outbox_event_id", "company_id");

CREATE INDEX "whatsapp_automation_checkpoints_company_id_created_at_idx"
ON "whatsapp_automation_checkpoints"("company_id", "created_at");

ALTER TABLE "whatsapp_automation_checkpoints"
ADD CONSTRAINT "whatsapp_automation_checkpoints_company_id_fkey"
FOREIGN KEY ("company_id") REFERENCES "companies"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_automation_checkpoints"
ADD CONSTRAINT "whatsapp_automation_checkpoints_outbox_event_id_company_id_fkey"
FOREIGN KEY ("outbox_event_id", "company_id")
REFERENCES "integration_outbox"("id", "company_id")
ON DELETE CASCADE ON UPDATE CASCADE;
