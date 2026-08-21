CREATE TABLE "whatsapp_history_import_states" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "status" VARCHAR(40) NOT NULL,
    "phase" VARCHAR(60),
    "manifest" JSONB NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "heartbeat_at" TIMESTAMPTZ(3),
    "error_code" VARCHAR(80),
    "error_message" VARCHAR(1000),
    "error_retryable" BOOLEAN,
    "error_occurred_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_history_import_states_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_history_upload_sessions" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(160),
    "expected_bytes" BIGINT NOT NULL,
    "uploaded_bytes" BIGINT NOT NULL DEFAULT 0,
    "fingerprint" CHAR(64) NOT NULL,
    "checksum_sha256" CHAR(64),
    "temporary_path" VARCHAR(1000) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "error_code" VARCHAR(80),
    "error_message" VARCHAR(1000),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_history_upload_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_history_import_audit_events" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "upload_id" UUID,
    "actor_user_id" UUID,
    "actor_username" VARCHAR(80),
    "action" VARCHAR(80) NOT NULL,
    "phase" VARCHAR(60),
    "old_value" JSONB,
    "new_value" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_history_import_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_history_import_states_id_company_id_key"
ON "whatsapp_history_import_states"("id", "company_id");

CREATE INDEX "whatsapp_history_import_states_company_id_status_updated_at_idx"
ON "whatsapp_history_import_states"("company_id", "status", "updated_at");

CREATE INDEX "whatsapp_history_import_states_status_lease_expires_at_idx"
ON "whatsapp_history_import_states"("status", "lease_expires_at");

CREATE INDEX "whatsapp_history_import_states_expires_at_idx"
ON "whatsapp_history_import_states"("expires_at");

CREATE UNIQUE INDEX "whatsapp_history_upload_sessions_company_id_batch_id_kind_fingerprint_key"
ON "whatsapp_history_upload_sessions"("company_id", "batch_id", "kind", "fingerprint");

CREATE INDEX "whatsapp_history_upload_sessions_company_id_batch_id_status_idx"
ON "whatsapp_history_upload_sessions"("company_id", "batch_id", "status");

CREATE INDEX "whatsapp_history_upload_sessions_status_expires_at_idx"
ON "whatsapp_history_upload_sessions"("status", "expires_at");

CREATE INDEX "whatsapp_history_import_audit_events_company_id_batch_id_created_at_idx"
ON "whatsapp_history_import_audit_events"("company_id", "batch_id", "created_at");

CREATE INDEX "whatsapp_history_import_audit_events_upload_id_created_at_idx"
ON "whatsapp_history_import_audit_events"("upload_id", "created_at");

CREATE OR REPLACE FUNCTION reject_whatsapp_history_import_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'whatsapp_history_import_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "whatsapp_history_import_audit_append_only"
BEFORE UPDATE OR DELETE ON "whatsapp_history_import_audit_events"
FOR EACH ROW EXECUTE FUNCTION reject_whatsapp_history_import_audit_mutation();
