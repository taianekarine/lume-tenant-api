CREATE UNIQUE INDEX "whatsapp_messages_id_company_conversation_key"
  ON "whatsapp_messages"("id", "company_id", "conversation_id");

CREATE UNIQUE INDEX "quote_requests_id_company_conversation_key"
  ON "quote_requests"("id", "company_id", "conversation_id");

CREATE UNIQUE INDEX "quote_proposal_documents_message_company_conversation_key"
  ON "quote_proposal_documents"("message_id", "company_id", "conversation_id");

ALTER TABLE "quote_proposal_documents"
  DROP CONSTRAINT "quote_proposal_documents_quote_company_fkey";

ALTER TABLE "quote_proposal_documents"
  DROP CONSTRAINT "quote_proposal_documents_message_company_fkey";

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
