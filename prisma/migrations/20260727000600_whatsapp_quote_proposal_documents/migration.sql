CREATE TYPE "QuoteProposalDocumentStatus" AS ENUM (
  'uploaded',
  'queued',
  'sent',
  'failed'
);

CREATE TABLE "quote_proposal_documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "quote_request_id" UUID NOT NULL,
  "uploaded_by_user_id" UUID NOT NULL,
  "message_id" UUID,
  "sequence" INTEGER NOT NULL,
  "status" "QuoteProposalDocumentStatus" NOT NULL DEFAULT 'uploaded',
  "file_name" VARCHAR(255) NOT NULL,
  "mime_type" VARCHAR(80) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "content" BYTEA NOT NULL,
  "provider_message_id" VARCHAR(160),
  "queued_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "quote_proposal_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quote_proposal_documents_sequence_positive"
    CHECK ("sequence" > 0),
  CONSTRAINT "quote_proposal_documents_size_valid"
    CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760),
  CONSTRAINT "quote_proposal_documents_sha256_valid"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "quote_proposal_documents_lifecycle_consistent"
    CHECK (
      ("status" = 'uploaded' AND "message_id" IS NULL AND "queued_at" IS NULL AND "sent_at" IS NULL AND "provider_message_id" IS NULL)
      OR
      ("status" = 'queued' AND "message_id" IS NOT NULL AND "queued_at" IS NOT NULL AND "sent_at" IS NULL AND "provider_message_id" IS NULL)
      OR
      ("status" = 'failed' AND "message_id" IS NOT NULL AND "queued_at" IS NOT NULL AND "sent_at" IS NULL AND "provider_message_id" IS NULL)
      OR
      ("status" = 'sent' AND "message_id" IS NOT NULL AND "queued_at" IS NOT NULL AND "sent_at" IS NOT NULL AND "provider_message_id" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "quote_proposal_documents_id_company_id_key"
  ON "quote_proposal_documents"("id", "company_id");
CREATE UNIQUE INDEX "quote_proposal_documents_company_quote_sequence_key"
  ON "quote_proposal_documents"("company_id", "quote_request_id", "sequence");
CREATE UNIQUE INDEX "quote_proposal_documents_message_company_key"
  ON "quote_proposal_documents"("message_id", "company_id");
CREATE INDEX "quote_proposal_documents_company_status_updated_idx"
  ON "quote_proposal_documents"("company_id", "status", "updated_at");
CREATE INDEX "quote_proposal_documents_company_conversation_created_idx"
  ON "quote_proposal_documents"("company_id", "conversation_id", "created_at");
CREATE INDEX "quote_proposal_documents_company_quote_created_idx"
  ON "quote_proposal_documents"("company_id", "quote_request_id", "created_at");

ALTER TABLE "quote_proposal_documents"
  ADD CONSTRAINT "quote_proposal_documents_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quote_proposal_documents"
  ADD CONSTRAINT "quote_proposal_documents_conversation_company_fkey"
  FOREIGN KEY ("conversation_id", "company_id")
  REFERENCES "whatsapp_conversations"("id", "company_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quote_proposal_documents"
  ADD CONSTRAINT "quote_proposal_documents_quote_company_fkey"
  FOREIGN KEY ("quote_request_id", "company_id")
  REFERENCES "quote_requests"("id", "company_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quote_proposal_documents"
  ADD CONSTRAINT "quote_proposal_documents_uploader_company_fkey"
  FOREIGN KEY ("uploaded_by_user_id", "company_id")
  REFERENCES "users"("id", "company_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_proposal_documents"
  ADD CONSTRAINT "quote_proposal_documents_message_company_fkey"
  FOREIGN KEY ("message_id", "company_id")
  REFERENCES "whatsapp_messages"("id", "company_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
