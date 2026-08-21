CREATE TYPE "RoutingClientType" AS ENUM ('pf', 'pj');

ALTER TABLE "routing_companies"
  ADD COLUMN "client_type" "RoutingClientType" NOT NULL DEFAULT 'pj',
  ADD COLUMN "individual_name" VARCHAR(160),
  ADD COLUMN "cpf" VARCHAR(11),
  ADD COLUMN "individual_email" VARCHAR(254),
  ADD COLUMN "individual_whatsapp" VARCHAR(20),
  ADD COLUMN "individual_phones" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "cnpj" VARCHAR(14),
  ADD COLUMN "legal_email" VARCHAR(254),
  ADD COLUMN "legal_whatsapp" VARCHAR(20),
  ADD COLUMN "legal_phones" JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE "routing_companies"
SET
  "client_type" = CASE WHEN length("tax_id") = 11 THEN 'pf'::"RoutingClientType" ELSE 'pj'::"RoutingClientType" END,
  "individual_name" = CASE WHEN length("tax_id") = 11 THEN "legal_name" ELSE NULL END,
  "cpf" = CASE WHEN length("tax_id") = 11 THEN "tax_id" ELSE NULL END,
  "cnpj" = CASE WHEN length("tax_id") = 14 THEN "tax_id" ELSE NULL END;

UPDATE "routing_companies"
SET "status" = 'inactive'
WHERE "status" = 'suspended';

CREATE UNIQUE INDEX "routing_companies_company_id_cpf_key"
  ON "routing_companies"("company_id", "cpf");
CREATE UNIQUE INDEX "routing_companies_company_id_cnpj_key"
  ON "routing_companies"("company_id", "cnpj");
CREATE UNIQUE INDEX "routing_companies_company_id_avic_external_id_key"
  ON "routing_companies"("company_id", "avic_external_id");

CREATE TABLE "routing_company_comments" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "routing_company_id" UUID NOT NULL,
  "comment" TEXT NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "updated_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "routing_company_comments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "routing_company_comments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "routing_company_comments_routing_company_id_company_id_fkey" FOREIGN KEY ("routing_company_id", "company_id") REFERENCES "routing_companies"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "routing_company_comments_created_by_user_id_company_id_fkey" FOREIGN KEY ("created_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "routing_company_comments_updated_by_user_id_company_id_fkey" FOREIGN KEY ("updated_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "routing_company_comments_id_company_id_key" ON "routing_company_comments"("id", "company_id");
CREATE INDEX "routing_company_comments_company_id_routing_company_id_created_at_idx" ON "routing_company_comments"("company_id", "routing_company_id", "created_at");

CREATE OR REPLACE FUNCTION "reject_routing_company_history_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'routing_company_history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "routing_company_history_append_only"
BEFORE UPDATE OR DELETE ON "routing_company_history"
FOR EACH ROW EXECUTE FUNCTION "reject_routing_company_history_mutation"();
