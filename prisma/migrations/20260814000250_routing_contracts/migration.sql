CREATE TYPE "RoutingRouteType" AS ENUM ('municipal', 'intermunicipal');
CREATE TYPE "RoutingContractStatus" AS ENUM ('draft', 'active', 'suspended', 'ended');
CREATE TYPE "RoutingContractPeriodicity" AS ENUM ('monthly', 'weekly', 'daily', 'per-route');

CREATE TABLE "routing_contracts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "routing_company_id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "operation_type" VARCHAR(120) NOT NULL,
    "route_type" "RoutingRouteType" NOT NULL,
    "status" "RoutingContractStatus" NOT NULL DEFAULT 'draft',
    "periodicity" "RoutingContractPeriodicity" NOT NULL,
    "contracted_vehicle_count" INTEGER NOT NULL,
    "predicted_vehicle_name" VARCHAR(160) NOT NULL,
    "predicted_vehicle_reference" VARCHAR(120),
    "predicted_vehicle_capacity" INTEGER NOT NULL,
    "contracted_km" DECIMAL(12,3),
    "planned_km" DECIMAL(12,3),
    "max_walking_distance_meters" INTEGER NOT NULL,
    "requires_documentation" BOOLEAN NOT NULL DEFAULT false,
    "required_document_type_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unit_name" VARCHAR(160) NOT NULL,
    "origin_label" VARCHAR(160) NOT NULL,
    "origin_street" VARCHAR(160) NOT NULL,
    "origin_number" VARCHAR(30) NOT NULL,
    "origin_complement" VARCHAR(120),
    "origin_district" VARCHAR(120) NOT NULL,
    "origin_postal_code" VARCHAR(8) NOT NULL,
    "origin_city" VARCHAR(120) NOT NULL,
    "origin_state" CHAR(2) NOT NULL,
    "origin_latitude" DECIMAL(10,7),
    "origin_longitude" DECIMAL(10,7),
    "destination_label" VARCHAR(160) NOT NULL,
    "destination_street" VARCHAR(160) NOT NULL,
    "destination_number" VARCHAR(30) NOT NULL,
    "destination_complement" VARCHAR(120),
    "destination_district" VARCHAR(120) NOT NULL,
    "destination_postal_code" VARCHAR(8) NOT NULL,
    "destination_city" VARCHAR(120) NOT NULL,
    "destination_state" CHAR(2) NOT NULL,
    "destination_latitude" DECIMAL(10,7),
    "destination_longitude" DECIMAL(10,7),
    "valid_from" DATE NOT NULL,
    "valid_until" DATE,
    "notes" VARCHAR(2000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "routing_contracts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "routing_contracts_vehicle_count_check" CHECK ("contracted_vehicle_count" > 0),
    CONSTRAINT "routing_contracts_vehicle_capacity_check" CHECK ("predicted_vehicle_capacity" > 0),
    CONSTRAINT "routing_contracts_walk_distance_check" CHECK ("max_walking_distance_meters" >= 0),
    CONSTRAINT "routing_contracts_validity_check" CHECK ("valid_until" IS NULL OR "valid_until" >= "valid_from"),
    CONSTRAINT "routing_contracts_document_rule_check" CHECK (
        NOT "requires_documentation" OR cardinality("required_document_type_codes") > 0
    )
);

CREATE TABLE "routing_contract_cost_centers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(160),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "routing_contract_cost_centers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "routing_contract_shifts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "required_arrival_time" CHAR(5) NOT NULL,
    "vehicle_count" INTEGER,
    "vehicle_capacity" INTEGER,
    "active_weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "routing_contract_shifts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "routing_contract_shifts_vehicle_count_check" CHECK ("vehicle_count" IS NULL OR "vehicle_count" > 0),
    CONSTRAINT "routing_contract_shifts_capacity_check" CHECK ("vehicle_capacity" IS NULL OR "vehicle_capacity" > 0),
    CONSTRAINT "routing_contract_shifts_weekdays_check" CHECK (
        "active_weekdays" <@ ARRAY[0,1,2,3,4,5,6]::INTEGER[]
    )
);

CREATE TABLE "routing_contract_history" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "command_id" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "before_snapshot" JSONB,
    "after_snapshot" JSONB NOT NULL,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "routing_contract_history_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "routing_contracts_id_company_id_key" ON "routing_contracts"("id", "company_id");
CREATE UNIQUE INDEX "routing_contracts_company_id_routing_company_id_code_key" ON "routing_contracts"("company_id", "routing_company_id", "code");
CREATE INDEX "routing_contracts_company_id_routing_company_id_status_valid_from_idx" ON "routing_contracts"("company_id", "routing_company_id", "status", "valid_from");
CREATE UNIQUE INDEX "routing_contract_cost_centers_company_id_contract_id_code_key" ON "routing_contract_cost_centers"("company_id", "contract_id", "code");
CREATE INDEX "routing_contract_cost_centers_company_id_code_idx" ON "routing_contract_cost_centers"("company_id", "code");
CREATE UNIQUE INDEX "routing_contract_shifts_company_id_contract_id_name_required_arrival_time_key" ON "routing_contract_shifts"("company_id", "contract_id", "name", "required_arrival_time");
CREATE INDEX "routing_contract_shifts_company_id_contract_id_idx" ON "routing_contract_shifts"("company_id", "contract_id");
CREATE UNIQUE INDEX "routing_contract_history_company_id_command_id_key" ON "routing_contract_history"("company_id", "command_id");
CREATE INDEX "routing_contract_history_company_id_contract_id_created_at_idx" ON "routing_contract_history"("company_id", "contract_id", "created_at");

ALTER TABLE "routing_contracts" ADD CONSTRAINT "routing_contracts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_contracts" ADD CONSTRAINT "routing_contracts_routing_company_id_company_id_fkey" FOREIGN KEY ("routing_company_id", "company_id") REFERENCES "routing_companies"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_contracts" ADD CONSTRAINT "routing_contracts_created_by_user_id_company_id_fkey" FOREIGN KEY ("created_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_contract_cost_centers" ADD CONSTRAINT "routing_contract_cost_centers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_contract_cost_centers" ADD CONSTRAINT "routing_contract_cost_centers_contract_id_company_id_fkey" FOREIGN KEY ("contract_id", "company_id") REFERENCES "routing_contracts"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_contract_shifts" ADD CONSTRAINT "routing_contract_shifts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_contract_shifts" ADD CONSTRAINT "routing_contract_shifts_contract_id_company_id_fkey" FOREIGN KEY ("contract_id", "company_id") REFERENCES "routing_contracts"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_contract_history" ADD CONSTRAINT "routing_contract_history_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_contract_history" ADD CONSTRAINT "routing_contract_history_contract_id_company_id_fkey" FOREIGN KEY ("contract_id", "company_id") REFERENCES "routing_contracts"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_contract_history" ADD CONSTRAINT "routing_contract_history_actor_user_id_company_id_fkey" FOREIGN KEY ("actor_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
