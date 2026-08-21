ALTER TYPE "DocumentAccessMode" ADD VALUE IF NOT EXISTS 'client';

CREATE TYPE "UserClientCategory" AS ENUM ('legal-entity', 'individual');

ALTER TABLE "users" ADD COLUMN "client_category" "UserClientCategory";

ALTER TABLE "users" ADD CONSTRAINT "users_client_access_consistency_check"
CHECK (
    (
        "document_access_mode" = 'client'
        AND (
            ("client_category" = 'legal-entity' AND "routing_company_id" IS NOT NULL)
            OR
            ("client_category" = 'individual' AND "routing_company_id" IS NULL)
        )
    )
    OR
    ("document_access_mode" <> 'client' AND "client_category" IS NULL)
);
