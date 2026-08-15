CREATE TYPE "PassengerStatus" AS ENUM (
    'active', 'on-leave', 'vacation', 'temporarily-off-route', 'unlinked'
);
CREATE TYPE "PassengerRegistrationStatus" AS ENUM ('ready', 'pending');
CREATE TYPE "RoutingDataOrigin" AS ENUM (
    'company', 'agent', 'operations', 'import', 'system'
);
CREATE TYPE "PassengerIssueStatus" AS ENUM ('open', 'resolved');
CREATE TYPE "PassengerImportBatchStatus" AS ENUM (
    'processing', 'completed', 'review-required', 'failed'
);
CREATE TYPE "PassengerImportAction" AS ENUM (
    'created', 'updated', 'kept', 'conflict', 'pending'
);

CREATE TABLE "passengers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "routing_company_id" UUID NOT NULL,
    "external_reference" VARCHAR(120),
    "identity_fingerprint" CHAR(64) NOT NULL,
    "full_name" VARCHAR(160) NOT NULL,
    "normalized_name" VARCHAR(160) NOT NULL,
    "shift" VARCHAR(80),
    "required_arrival_time" CHAR(5),
    "sector" VARCHAR(120),
    "accessibility_required" BOOLEAN NOT NULL DEFAULT false,
    "accessibility_notes" VARCHAR(1000),
    "residence_street" VARCHAR(160),
    "residence_number" VARCHAR(30),
    "residence_complement" VARCHAR(120),
    "residence_district" VARCHAR(120),
    "residence_postal_code" VARCHAR(8),
    "residence_city" VARCHAR(120),
    "residence_state" CHAR(2),
    "residence_latitude" DECIMAL(10,7),
    "residence_longitude" DECIMAL(10,7),
    "predefined_boarding_label" VARCHAR(160),
    "predefined_boarding_street" VARCHAR(160),
    "predefined_boarding_number" VARCHAR(30),
    "predefined_boarding_complement" VARCHAR(120),
    "predefined_boarding_district" VARCHAR(120),
    "predefined_boarding_postal_code" VARCHAR(8),
    "predefined_boarding_city" VARCHAR(120),
    "predefined_boarding_state" CHAR(2),
    "predefined_boarding_latitude" DECIMAL(10,7),
    "predefined_boarding_longitude" DECIMAL(10,7),
    "predefined_boarding_origin" "RoutingDataOrigin",
    "status" "PassengerStatus" NOT NULL DEFAULT 'active',
    "registration_status" "PassengerRegistrationStatus" NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "passengers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "passenger_document_data" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "document_type_code" VARCHAR(80) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "origin" "RoutingDataOrigin" NOT NULL DEFAULT 'company',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "passenger_document_data_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "passenger_issues" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "field" VARCHAR(100) NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "resolution_action" VARCHAR(500) NOT NULL,
    "blocks_routing" BOOLEAN NOT NULL DEFAULT true,
    "status" "PassengerIssueStatus" NOT NULL DEFAULT 'open',
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "passenger_issues_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "passenger_history" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "command_id" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "before_snapshot" JSONB,
    "after_snapshot" JSONB NOT NULL,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "passenger_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "passenger_import_batches" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "command_id" UUID NOT NULL,
    "route_id" UUID,
    "source_file_name" VARCHAR(255) NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "status" "PassengerImportBatchStatus" NOT NULL DEFAULT 'processing',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "kept_count" INTEGER NOT NULL DEFAULT 0,
    "pending_count" INTEGER NOT NULL DEFAULT 0,
    "conflict_count" INTEGER NOT NULL DEFAULT 0,
    "requires_rerouting" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "passenger_import_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "passenger_import_records" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "routing_company_id" UUID,
    "passenger_id" UUID,
    "action" "PassengerImportAction" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "problems" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "passenger_import_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "passengers_id_company_id_key" ON "passengers"("id", "company_id");
CREATE UNIQUE INDEX "passengers_company_id_routing_company_id_external_reference_key" ON "passengers"("company_id", "routing_company_id", "external_reference");
CREATE INDEX "passengers_company_id_routing_company_id_status_registration_status_idx" ON "passengers"("company_id", "routing_company_id", "status", "registration_status");
CREATE INDEX "passengers_company_id_routing_company_id_identity_fingerprint_idx" ON "passengers"("company_id", "routing_company_id", "identity_fingerprint");
CREATE INDEX "passengers_company_id_normalized_name_idx" ON "passengers"("company_id", "normalized_name");
CREATE UNIQUE INDEX "passenger_document_data_company_id_passenger_id_document_type_code_key" ON "passenger_document_data"("company_id", "passenger_id", "document_type_code");
CREATE INDEX "passenger_document_data_company_id_document_type_code_idx" ON "passenger_document_data"("company_id", "document_type_code");
CREATE UNIQUE INDEX "passenger_issues_company_id_passenger_id_code_status_key" ON "passenger_issues"("company_id", "passenger_id", "code", "status");
CREATE INDEX "passenger_issues_company_id_status_blocks_routing_idx" ON "passenger_issues"("company_id", "status", "blocks_routing");
CREATE UNIQUE INDEX "passenger_history_company_id_command_id_key" ON "passenger_history"("company_id", "command_id");
CREATE INDEX "passenger_history_company_id_passenger_id_created_at_idx" ON "passenger_history"("company_id", "passenger_id", "created_at");
CREATE UNIQUE INDEX "passenger_import_batches_id_company_id_key" ON "passenger_import_batches"("id", "company_id");
CREATE UNIQUE INDEX "passenger_import_batches_company_id_command_id_key" ON "passenger_import_batches"("company_id", "command_id");
CREATE UNIQUE INDEX "passenger_import_batches_company_id_source_sha256_command_id_key" ON "passenger_import_batches"("company_id", "source_sha256", "command_id");
CREATE INDEX "passenger_import_batches_company_id_status_created_at_idx" ON "passenger_import_batches"("company_id", "status", "created_at");
CREATE INDEX "passenger_import_batches_company_id_route_id_created_at_idx" ON "passenger_import_batches"("company_id", "route_id", "created_at");
CREATE UNIQUE INDEX "passenger_import_records_batch_id_row_number_key" ON "passenger_import_records"("batch_id", "row_number");
CREATE INDEX "passenger_import_records_company_id_routing_company_id_action_idx" ON "passenger_import_records"("company_id", "routing_company_id", "action");
CREATE INDEX "passenger_import_records_company_id_passenger_id_idx" ON "passenger_import_records"("company_id", "passenger_id");

ALTER TABLE "passengers" ADD CONSTRAINT "passengers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "passengers" ADD CONSTRAINT "passengers_routing_company_id_company_id_fkey" FOREIGN KEY ("routing_company_id", "company_id") REFERENCES "routing_companies"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "passengers" ADD CONSTRAINT "passengers_created_by_user_id_company_id_fkey" FOREIGN KEY ("created_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "passenger_document_data" ADD CONSTRAINT "passenger_document_data_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "passenger_document_data" ADD CONSTRAINT "passenger_document_data_passenger_id_company_id_fkey" FOREIGN KEY ("passenger_id", "company_id") REFERENCES "passengers"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "passenger_issues" ADD CONSTRAINT "passenger_issues_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "passenger_issues" ADD CONSTRAINT "passenger_issues_passenger_id_company_id_fkey" FOREIGN KEY ("passenger_id", "company_id") REFERENCES "passengers"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "passenger_history" ADD CONSTRAINT "passenger_history_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "passenger_history" ADD CONSTRAINT "passenger_history_passenger_id_company_id_fkey" FOREIGN KEY ("passenger_id", "company_id") REFERENCES "passengers"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "passenger_history" ADD CONSTRAINT "passenger_history_actor_user_id_company_id_fkey" FOREIGN KEY ("actor_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "passenger_import_batches" ADD CONSTRAINT "passenger_import_batches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "passenger_import_batches" ADD CONSTRAINT "passenger_import_batches_actor_user_id_company_id_fkey" FOREIGN KEY ("actor_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "passenger_import_records" ADD CONSTRAINT "passenger_import_records_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "passenger_import_records" ADD CONSTRAINT "passenger_import_records_batch_id_company_id_fkey" FOREIGN KEY ("batch_id", "company_id") REFERENCES "passenger_import_batches"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "passenger_import_records" ADD CONSTRAINT "passenger_import_records_routing_company_id_company_id_fkey" FOREIGN KEY ("routing_company_id", "company_id") REFERENCES "routing_companies"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "passenger_import_records" ADD CONSTRAINT "passenger_import_records_passenger_id_company_id_fkey" FOREIGN KEY ("passenger_id", "company_id") REFERENCES "passengers"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
