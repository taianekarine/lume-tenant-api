CREATE UNIQUE INDEX CONCURRENTLY "integration_outbox_id_company_id_key"
ON "integration_outbox"("id", "company_id");
