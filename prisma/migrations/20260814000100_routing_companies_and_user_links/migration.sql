CREATE TYPE "RoutingCompanyStatus" AS ENUM ('active', 'inactive', 'suspended');

ALTER TYPE "DepartmentCode" ADD VALUE IF NOT EXISTS 'client-company';

CREATE TABLE "routing_companies" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "tax_id" VARCHAR(14) NOT NULL,
    "legal_name" VARCHAR(160) NOT NULL,
    "trade_name" VARCHAR(120),
    "cost_center" VARCHAR(120),
    "status" "RoutingCompanyStatus" NOT NULL DEFAULT 'active',
    "avic_external_id" VARCHAR(160),
    "avic_last_synced_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "routing_companies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "routing_company_history" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "routing_company_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "command_id" UUID NOT NULL,
    "action" VARCHAR(80) NOT NULL,
    "before_snapshot" JSONB,
    "after_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routing_company_history_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "users" ADD COLUMN "routing_company_id" UUID;

CREATE UNIQUE INDEX "routing_companies_id_company_id_key"
    ON "routing_companies"("id", "company_id");
CREATE UNIQUE INDEX "routing_companies_company_id_tax_id_key"
    ON "routing_companies"("company_id", "tax_id");
CREATE INDEX "routing_companies_company_id_status_legal_name_idx"
    ON "routing_companies"("company_id", "status", "legal_name");
CREATE UNIQUE INDEX "routing_company_history_company_id_command_id_key"
    ON "routing_company_history"("company_id", "command_id");
CREATE INDEX "routing_company_history_company_id_routing_company_id_created_at_idx"
    ON "routing_company_history"("company_id", "routing_company_id", "created_at");
CREATE INDEX "users_company_id_routing_company_id_idx"
    ON "users"("company_id", "routing_company_id");

ALTER TABLE "routing_companies"
    ADD CONSTRAINT "routing_companies_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "routing_companies"
    ADD CONSTRAINT "routing_companies_created_by_user_id_company_id_fkey"
    FOREIGN KEY ("created_by_user_id", "company_id")
    REFERENCES "users"("id", "company_id")
    ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "users"
    ADD CONSTRAINT "users_routing_company_id_company_id_fkey"
    FOREIGN KEY ("routing_company_id", "company_id")
    REFERENCES "routing_companies"("id", "company_id")
    ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "routing_company_history"
    ADD CONSTRAINT "routing_company_history_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "routing_company_history"
    ADD CONSTRAINT "routing_company_history_routing_company_id_company_id_fkey"
    FOREIGN KEY ("routing_company_id", "company_id")
    REFERENCES "routing_companies"("id", "company_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "routing_company_history"
    ADD CONSTRAINT "routing_company_history_actor_user_id_company_id_fkey"
    FOREIGN KEY ("actor_user_id", "company_id")
    REFERENCES "users"("id", "company_id")
    ON DELETE NO ACTION ON UPDATE CASCADE;
