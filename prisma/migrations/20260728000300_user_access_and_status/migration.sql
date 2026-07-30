CREATE TYPE "UserAccountStatus" AS ENUM ('active', 'inactive', 'suspended');

ALTER TABLE "users"
ADD COLUMN "permission_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "status" "UserAccountStatus" NOT NULL DEFAULT 'active',
ADD COLUMN "suspended_until" TIMESTAMP(3),
ADD COLUMN "suspension_reason" VARCHAR(500);

UPDATE "users"
SET "status" = CASE
  WHEN "is_active" THEN 'active'::"UserAccountStatus"
  ELSE 'inactive'::"UserAccountStatus"
END;

CREATE INDEX "users_company_id_status_name_idx"
ON "users"("company_id", "status", "name");

CREATE INDEX "users_departments_idx"
ON "users" USING GIN ("departments");

CREATE INDEX "users_permission_codes_idx"
ON "users" USING GIN ("permission_codes");
