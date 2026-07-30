ALTER TABLE "quote_requests"
  ADD COLUMN "requested_by_user_id" UUID,
  ADD COLUMN "decision_reason" VARCHAR(500),
  ADD COLUMN "decided_at" TIMESTAMP(3),
  ADD COLUMN "decided_by_user_id" UUID;

ALTER TABLE "quote_proposal_documents"
  ADD COLUMN "sent_by_user_id" UUID;

UPDATE "quote_proposal_documents"
SET "sent_by_user_id" = "uploaded_by_user_id"
WHERE "status" IN ('queued', 'sent', 'failed');

ALTER TABLE "quote_requests"
  ADD CONSTRAINT "quote_requests_requested_by_user_id_company_id_fkey"
  FOREIGN KEY ("requested_by_user_id", "company_id")
  REFERENCES "users"("id", "company_id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "quote_requests"
  ADD CONSTRAINT "quote_requests_decided_by_user_id_company_id_fkey"
  FOREIGN KEY ("decided_by_user_id", "company_id")
  REFERENCES "users"("id", "company_id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "quote_proposal_documents"
  ADD CONSTRAINT "quote_proposal_documents_sent_by_user_id_company_id_fkey"
  FOREIGN KEY ("sent_by_user_id", "company_id")
  REFERENCES "users"("id", "company_id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

CREATE INDEX "quote_requests_requested_by_user_id_company_id_created_at_idx"
  ON "quote_requests"("requested_by_user_id", "company_id", "created_at");

CREATE INDEX "quote_requests_decided_by_user_id_company_id_decided_at_idx"
  ON "quote_requests"("decided_by_user_id", "company_id", "decided_at");

CREATE INDEX "quote_proposal_documents_sent_by_user_id_company_id_sent_at_idx"
  ON "quote_proposal_documents"("sent_by_user_id", "company_id", "sent_at");
