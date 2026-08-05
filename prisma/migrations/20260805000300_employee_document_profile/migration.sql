ALTER TABLE "users"
  ADD COLUMN "job_title" VARCHAR(120),
  ADD COLUMN "marital_status" VARCHAR(30),
  ADD COLUMN "military_document_status" VARCHAR(30) NOT NULL DEFAULT 'pending-confirmation',
  ADD COLUMN "dependents" JSONB NOT NULL DEFAULT '[]';

ALTER TYPE "DocumentItemStatus" ADD VALUE IF NOT EXISTS 'waived';

ALTER TABLE "users"
  ADD CONSTRAINT "users_marital_status_check"
    CHECK ("marital_status" IS NULL OR "marital_status" IN ('single', 'married', 'stable-union', 'divorced', 'widowed', 'not-informed')),
  ADD CONSTRAINT "users_military_document_status_check"
    CHECK ("military_document_status" IN ('applicable', 'not-applicable', 'pending-confirmation')),
  ADD CONSTRAINT "users_dependents_array_check"
    CHECK (jsonb_typeof("dependents") = 'array');
