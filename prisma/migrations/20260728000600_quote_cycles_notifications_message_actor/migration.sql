ALTER TABLE "whatsapp_messages"
  ADD COLUMN "actor_user_id" UUID;

ALTER TABLE "whatsapp_messages"
  ADD CONSTRAINT "whatsapp_messages_actor_user_id_company_id_fkey"
  FOREIGN KEY ("actor_user_id", "company_id")
  REFERENCES "users"("id", "company_id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

CREATE INDEX "whatsapp_messages_actor_user_id_company_id_occurred_at_idx"
  ON "whatsapp_messages"("actor_user_id", "company_id", "occurred_at");

CREATE TABLE "quote_notification_reads" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "quote_request_id" UUID NOT NULL,
  "notification_key" VARCHAR(120) NOT NULL,
  "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "quote_notification_reads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quote_notification_reads_company_id_fkey"
    FOREIGN KEY ("company_id")
    REFERENCES "companies"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT "quote_notification_reads_user_id_company_id_fkey"
    FOREIGN KEY ("user_id", "company_id")
    REFERENCES "users"("id", "company_id")
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT "quote_notification_reads_quote_request_id_company_id_fkey"
    FOREIGN KEY ("quote_request_id", "company_id")
    REFERENCES "quote_requests"("id", "company_id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "quote_notification_reads_company_user_quote_key"
  ON "quote_notification_reads"(
    "company_id",
    "user_id",
    "quote_request_id",
    "notification_key"
  );

CREATE INDEX "quote_notification_reads_company_user_key_read_idx"
  ON "quote_notification_reads"(
    "company_id",
    "user_id",
    "notification_key",
    "read_at"
  );

CREATE INDEX "quote_notification_reads_company_quote_idx"
  ON "quote_notification_reads"("company_id", "quote_request_id");
