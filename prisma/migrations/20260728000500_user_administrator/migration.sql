ALTER TABLE "users"
ADD COLUMN "is_administrator" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "users_company_id_is_administrator_status_idx"
ON "users"("company_id", "is_administrator", "status");
