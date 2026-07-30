ALTER TABLE "quote_notification_reads"
  ADD COLUMN "quote_version" INTEGER NOT NULL DEFAULT 1;

DROP INDEX "quote_notification_reads_company_user_quote_key";

CREATE UNIQUE INDEX "quote_notification_reads_company_user_quote_key"
  ON "quote_notification_reads"(
    "company_id",
    "user_id",
    "quote_request_id",
    "notification_key",
    "quote_version"
  );

ALTER TABLE "quote_proposal_documents"
  ADD COLUMN "delivery_batch_id" UUID;

CREATE INDEX "quote_proposal_documents_company_quote_batch_status_idx"
  ON "quote_proposal_documents"(
    "company_id",
    "quote_request_id",
    "delivery_batch_id",
    "status"
  );
