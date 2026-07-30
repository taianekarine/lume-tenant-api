CREATE TYPE "WhatsAppImportBatchStatus" AS ENUM (
  'applying',
  'applied',
  'failed',
  'rolled-back'
);

CREATE TYPE "WhatsAppImportRecordStatus" AS ENUM (
  'applied',
  'rolled-back'
);

CREATE TABLE "whatsapp_import_batches" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "package_path" VARCHAR(1000) NOT NULL,
  "workbook_sha256" CHAR(64) NOT NULL,
  "package_sha256" CHAR(64) NOT NULL,
  "cutoff_at" TIMESTAMP(3) NOT NULL,
  "status" "WhatsAppImportBatchStatus" NOT NULL DEFAULT 'applying',
  "expected_counts" JSONB NOT NULL,
  "applied_counts" JSONB,
  "outbox_count_before" INTEGER NOT NULL,
  "outbox_count_after" INTEGER,
  "error_message" VARCHAR(1000),
  "claim_id" UUID,
  "lease_until" TIMESTAMP(3),
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_at" TIMESTAMP(3),
  "rolled_back_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "whatsapp_import_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_import_records" (
  "id" UUID NOT NULL,
  "batch_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "source_system" VARCHAR(80) NOT NULL,
  "external_conversation_id" VARCHAR(160) NOT NULL,
  "conversation_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "action" VARCHAR(20) NOT NULL,
  "before_snapshot" JSONB,
  "after_snapshot" JSONB NOT NULL,
  "created_resource_ids" JSONB NOT NULL,
  "status" "WhatsAppImportRecordStatus" NOT NULL DEFAULT 'applied',
  "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rolled_back_at" TIMESTAMP(3),

  CONSTRAINT "whatsapp_import_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_import_external_refs" (
  "id" UUID NOT NULL,
  "batch_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "entity_type" VARCHAR(20) NOT NULL,
  "source_system" VARCHAR(80) NOT NULL,
  "external_id" VARCHAR(160) NOT NULL,
  "internal_id" UUID NOT NULL,
  "payload_hash" CHAR(64),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "whatsapp_import_external_refs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_import_batches_company_name_key"
  ON "whatsapp_import_batches"("company_id", "name");

CREATE UNIQUE INDEX "whatsapp_import_batches_id_company_key"
  ON "whatsapp_import_batches"("id", "company_id");

CREATE INDEX "whatsapp_import_batches_company_status_created_idx"
  ON "whatsapp_import_batches"("company_id", "status", "created_at");

CREATE INDEX "whatsapp_import_batches_status_lease_idx"
  ON "whatsapp_import_batches"("status", "lease_until");

CREATE INDEX "whatsapp_import_batches_actor_company_created_idx"
  ON "whatsapp_import_batches"("actor_user_id", "company_id", "created_at");

CREATE UNIQUE INDEX "whatsapp_import_records_batch_source_external_key"
  ON "whatsapp_import_records"(
    "batch_id",
    "source_system",
    "external_conversation_id"
  );

CREATE INDEX "whatsapp_import_records_company_conversation_idx"
  ON "whatsapp_import_records"("company_id", "conversation_id");

CREATE INDEX "whatsapp_import_records_company_status_applied_idx"
  ON "whatsapp_import_records"("company_id", "status", "applied_at");

CREATE UNIQUE INDEX "whatsapp_import_external_refs_company_entity_source_external_key"
  ON "whatsapp_import_external_refs"(
    "company_id",
    "entity_type",
    "source_system",
    "external_id"
  );

CREATE INDEX "whatsapp_import_external_refs_company_entity_internal_idx"
  ON "whatsapp_import_external_refs"(
    "company_id",
    "entity_type",
    "internal_id"
  );

CREATE INDEX "whatsapp_import_external_refs_batch_entity_idx"
  ON "whatsapp_import_external_refs"("batch_id", "entity_type");

ALTER TABLE "whatsapp_import_batches"
  ADD CONSTRAINT "whatsapp_import_batches_company_fkey"
  FOREIGN KEY ("company_id")
  REFERENCES "companies"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "whatsapp_import_batches"
  ADD CONSTRAINT "whatsapp_import_batches_channel_company_fkey"
  FOREIGN KEY ("channel_id", "company_id")
  REFERENCES "whatsapp_channels"("id", "company_id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "whatsapp_import_batches"
  ADD CONSTRAINT "whatsapp_import_batches_actor_company_fkey"
  FOREIGN KEY ("actor_user_id", "company_id")
  REFERENCES "users"("id", "company_id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "whatsapp_import_records"
  ADD CONSTRAINT "whatsapp_import_records_batch_company_fkey"
  FOREIGN KEY ("batch_id", "company_id")
  REFERENCES "whatsapp_import_batches"("id", "company_id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "whatsapp_import_records"
  ADD CONSTRAINT "whatsapp_import_records_company_fkey"
  FOREIGN KEY ("company_id")
  REFERENCES "companies"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "whatsapp_import_external_refs"
  ADD CONSTRAINT "whatsapp_import_external_refs_batch_company_fkey"
  FOREIGN KEY ("batch_id", "company_id")
  REFERENCES "whatsapp_import_batches"("id", "company_id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "whatsapp_import_external_refs"
  ADD CONSTRAINT "whatsapp_import_external_refs_company_fkey"
  FOREIGN KEY ("company_id")
  REFERENCES "companies"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
