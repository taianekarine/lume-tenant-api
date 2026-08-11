ALTER TABLE "users"
ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

CREATE INDEX "users_company_id_deleted_at_idx"
ON "users"("company_id", "deleted_at");
