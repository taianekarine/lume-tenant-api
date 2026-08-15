CREATE TYPE "RoutingRouteStatus" AS ENUM (
    'draft', 'routed', 'in-review', 'pending-approval', 'approved', 'published'
);
CREATE TYPE "RoutingDirection" AS ENUM ('outbound', 'return');
CREATE TYPE "RoutingAssignmentStatus" AS ENUM (
    'assigned', 'overflow', 'pending-data', 'pending-documents'
);

CREATE TABLE "routing_routes" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "routing_company_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "shift" VARCHAR(80) NOT NULL,
    "required_arrival_time" CHAR(5) NOT NULL,
    "type" "RoutingRouteType" NOT NULL,
    "requires_documentation" BOOLEAN NOT NULL DEFAULT false,
    "required_document_type_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
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
    "predicted_vehicle_reference" VARCHAR(120),
    "predicted_vehicle_name" VARCHAR(160) NOT NULL,
    "predicted_vehicle_capacity" INTEGER NOT NULL,
    "max_walking_distance_meters" INTEGER NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_until" DATE,
    "notes" VARCHAR(2000),
    "status" "RoutingRouteStatus" NOT NULL DEFAULT 'draft',
    "needs_rerouting" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "plan_version" INTEGER NOT NULL DEFAULT 0,
    "approved_version" INTEGER,
    "planned_outbound_km" DECIMAL(10,3),
    "planned_return_km" DECIMAL(10,3),
    "planned_total_km" DECIMAL(10,3),
    "estimated_duration_minutes" INTEGER,
    "overflow_passenger_count" INTEGER NOT NULL DEFAULT 0,
    "additional_route_suggested" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID NOT NULL,
    "published_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "routing_routes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "routing_routes_capacity_check" CHECK ("predicted_vehicle_capacity" > 0),
    CONSTRAINT "routing_routes_walk_distance_check" CHECK ("max_walking_distance_meters" >= 0),
    CONSTRAINT "routing_routes_validity_check" CHECK ("valid_until" IS NULL OR "valid_until" >= "valid_from"),
    CONSTRAINT "routing_routes_document_rule_check" CHECK (
        NOT "requires_documentation" OR cardinality("required_document_type_codes") > 0
    )
);

CREATE TABLE "routing_route_points" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "direction" "RoutingDirection" NOT NULL DEFAULT 'outbound',
    "sequence" INTEGER NOT NULL,
    "label" VARCHAR(160) NOT NULL,
    "street" VARCHAR(160) NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "complement" VARCHAR(120),
    "district" VARCHAR(120) NOT NULL,
    "postal_code" VARCHAR(8) NOT NULL,
    "city" VARCHAR(120) NOT NULL,
    "state" CHAR(2) NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "origin" "RoutingDataOrigin" NOT NULL,
    "scheduled_time" CHAR(5),
    "alerts" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "routing_route_points_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "routing_route_points_sequence_check" CHECK ("sequence" >= 0)
);

CREATE TABLE "routing_route_passengers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "point_id" UUID,
    "status" "RoutingAssignmentStatus" NOT NULL,
    "walking_distance_meters" INTEGER,
    "boarding_order" INTEGER,
    "origin" "RoutingDataOrigin" NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "routing_route_passengers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "routing_route_history" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "command_id" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "before_snapshot" JSONB,
    "after_snapshot" JSONB NOT NULL,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "routing_route_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "routing_route_versions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "plan_version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "routing_route_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "routing_route_approvals" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "approved_version" INTEGER NOT NULL,
    "approved_by_user_id" UUID NOT NULL,
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "routing_route_approvals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "routing_navigation_links" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "route_version" INTEGER NOT NULL,
    "direction" "RoutingDirection" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "routing_navigation_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "routing_route_executions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "route_version" INTEGER NOT NULL,
    "executed_vehicle_reference" VARCHAR(120),
    "initial_odometer_km" DECIMAL(12,3),
    "final_odometer_km" DECIMAL(12,3),
    "executed_km" DECIMAL(12,3),
    "vehicle_records" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "routing_route_executions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "routing_route_executions_odometer_check" CHECK (
        "initial_odometer_km" IS NULL OR "final_odometer_km" IS NULL OR "final_odometer_km" >= "initial_odometer_km"
    )
);

CREATE UNIQUE INDEX "routing_routes_id_company_id_key" ON "routing_routes"("id", "company_id");
CREATE UNIQUE INDEX "routing_routes_company_id_routing_company_id_code_key" ON "routing_routes"("company_id", "routing_company_id", "code");
CREATE INDEX "routing_routes_company_id_contract_id_status_idx" ON "routing_routes"("company_id", "contract_id", "status");
CREATE INDEX "routing_routes_company_id_routing_company_id_status_valid_from_idx" ON "routing_routes"("company_id", "routing_company_id", "status", "valid_from");
CREATE INDEX "routing_routes_company_id_status_updated_at_idx" ON "routing_routes"("company_id", "status", "updated_at");
CREATE UNIQUE INDEX "routing_route_points_id_company_id_key" ON "routing_route_points"("id", "company_id");
CREATE UNIQUE INDEX "routing_route_points_company_id_route_id_direction_sequence_key" ON "routing_route_points"("company_id", "route_id", "direction", "sequence");
CREATE INDEX "routing_route_points_company_id_route_id_idx" ON "routing_route_points"("company_id", "route_id");
CREATE UNIQUE INDEX "routing_route_passengers_company_id_route_id_passenger_id_key" ON "routing_route_passengers"("company_id", "route_id", "passenger_id");
CREATE INDEX "routing_route_passengers_company_id_route_id_status_idx" ON "routing_route_passengers"("company_id", "route_id", "status");
CREATE INDEX "routing_route_passengers_company_id_passenger_id_idx" ON "routing_route_passengers"("company_id", "passenger_id");
CREATE UNIQUE INDEX "routing_route_history_company_id_command_id_key" ON "routing_route_history"("company_id", "command_id");
CREATE INDEX "routing_route_history_company_id_route_id_created_at_idx" ON "routing_route_history"("company_id", "route_id", "created_at");
CREATE UNIQUE INDEX "routing_route_versions_company_id_route_id_version_key" ON "routing_route_versions"("company_id", "route_id", "version");
CREATE INDEX "routing_route_versions_company_id_route_id_created_at_idx" ON "routing_route_versions"("company_id", "route_id", "created_at");
CREATE UNIQUE INDEX "routing_route_approvals_company_id_route_id_approved_version_key" ON "routing_route_approvals"("company_id", "route_id", "approved_version");
CREATE INDEX "routing_route_approvals_company_id_approved_by_user_id_created_at_idx" ON "routing_route_approvals"("company_id", "approved_by_user_id", "created_at");
CREATE UNIQUE INDEX "routing_navigation_links_company_id_route_id_route_version_direction_sequence_key" ON "routing_navigation_links"("company_id", "route_id", "route_version", "direction", "sequence");
CREATE INDEX "routing_navigation_links_company_id_route_id_route_version_idx" ON "routing_navigation_links"("company_id", "route_id", "route_version");
CREATE UNIQUE INDEX "routing_route_executions_company_id_route_id_route_version_key" ON "routing_route_executions"("company_id", "route_id", "route_version");
CREATE INDEX "routing_route_executions_company_id_route_id_idx" ON "routing_route_executions"("company_id", "route_id");

ALTER TABLE "routing_routes" ADD CONSTRAINT "routing_routes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_routes" ADD CONSTRAINT "routing_routes_routing_company_id_company_id_fkey" FOREIGN KEY ("routing_company_id", "company_id") REFERENCES "routing_companies"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_routes" ADD CONSTRAINT "routing_routes_contract_id_company_id_fkey" FOREIGN KEY ("contract_id", "company_id") REFERENCES "routing_contracts"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_routes" ADD CONSTRAINT "routing_routes_created_by_user_id_company_id_fkey" FOREIGN KEY ("created_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_routes" ADD CONSTRAINT "routing_routes_published_by_user_id_company_id_fkey" FOREIGN KEY ("published_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_route_points" ADD CONSTRAINT "routing_route_points_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_route_points" ADD CONSTRAINT "routing_route_points_route_id_company_id_fkey" FOREIGN KEY ("route_id", "company_id") REFERENCES "routing_routes"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_route_passengers" ADD CONSTRAINT "routing_route_passengers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_route_passengers" ADD CONSTRAINT "routing_route_passengers_route_id_company_id_fkey" FOREIGN KEY ("route_id", "company_id") REFERENCES "routing_routes"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_route_passengers" ADD CONSTRAINT "routing_route_passengers_passenger_id_company_id_fkey" FOREIGN KEY ("passenger_id", "company_id") REFERENCES "passengers"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_route_passengers" ADD CONSTRAINT "routing_route_passengers_point_id_company_id_fkey" FOREIGN KEY ("point_id", "company_id") REFERENCES "routing_route_points"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_route_history" ADD CONSTRAINT "routing_route_history_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_route_history" ADD CONSTRAINT "routing_route_history_route_id_company_id_fkey" FOREIGN KEY ("route_id", "company_id") REFERENCES "routing_routes"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_route_history" ADD CONSTRAINT "routing_route_history_actor_user_id_company_id_fkey" FOREIGN KEY ("actor_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_route_versions" ADD CONSTRAINT "routing_route_versions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_route_versions" ADD CONSTRAINT "routing_route_versions_route_id_company_id_fkey" FOREIGN KEY ("route_id", "company_id") REFERENCES "routing_routes"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_route_approvals" ADD CONSTRAINT "routing_route_approvals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_route_approvals" ADD CONSTRAINT "routing_route_approvals_route_id_company_id_fkey" FOREIGN KEY ("route_id", "company_id") REFERENCES "routing_routes"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_route_approvals" ADD CONSTRAINT "routing_route_approvals_approved_by_user_id_company_id_fkey" FOREIGN KEY ("approved_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_navigation_links" ADD CONSTRAINT "routing_navigation_links_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_navigation_links" ADD CONSTRAINT "routing_navigation_links_route_id_company_id_fkey" FOREIGN KEY ("route_id", "company_id") REFERENCES "routing_routes"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_route_executions" ADD CONSTRAINT "routing_route_executions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_route_executions" ADD CONSTRAINT "routing_route_executions_route_id_company_id_fkey" FOREIGN KEY ("route_id", "company_id") REFERENCES "routing_routes"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
