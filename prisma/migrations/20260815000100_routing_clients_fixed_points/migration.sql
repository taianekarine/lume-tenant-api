CREATE TYPE "RoutingFixedPointStatus" AS ENUM ('active', 'inactive');

CREATE TABLE "routing_fixed_points" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "routing_company_id" UUID,
    "code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" "RoutingFixedPointStatus" NOT NULL DEFAULT 'active',
    "street" VARCHAR(160) NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "complement" VARCHAR(120),
    "district" VARCHAR(120) NOT NULL,
    "postal_code" VARCHAR(8) NOT NULL,
    "city" VARCHAR(120) NOT NULL,
    "state" CHAR(2) NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "routing_fixed_points_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "routing_contracts" ADD COLUMN "origin_fixed_point_id" UUID;
ALTER TABLE "routing_contracts" ADD COLUMN "destination_fixed_point_id" UUID;
ALTER TABLE "passengers" ADD COLUMN "predefined_boarding_fixed_point_id" UUID;
ALTER TABLE "routing_route_points" ADD COLUMN "fixed_point_id" UUID;

CREATE UNIQUE INDEX "routing_fixed_points_id_company_id_key" ON "routing_fixed_points"("id", "company_id");
CREATE UNIQUE INDEX "routing_fixed_points_company_id_code_key" ON "routing_fixed_points"("company_id", "code");
CREATE INDEX "routing_fixed_points_company_id_routing_company_id_status_name_idx" ON "routing_fixed_points"("company_id", "routing_company_id", "status", "name");

ALTER TABLE "routing_fixed_points" ADD CONSTRAINT "routing_fixed_points_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_fixed_points" ADD CONSTRAINT "routing_fixed_points_routing_company_id_company_id_fkey" FOREIGN KEY ("routing_company_id", "company_id") REFERENCES "routing_companies"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_fixed_points" ADD CONSTRAINT "routing_fixed_points_created_by_user_id_company_id_fkey" FOREIGN KEY ("created_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_contracts" ADD CONSTRAINT "routing_contracts_origin_fixed_point_id_company_id_fkey" FOREIGN KEY ("origin_fixed_point_id", "company_id") REFERENCES "routing_fixed_points"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_contracts" ADD CONSTRAINT "routing_contracts_destination_fixed_point_id_company_id_fkey" FOREIGN KEY ("destination_fixed_point_id", "company_id") REFERENCES "routing_fixed_points"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "passengers" ADD CONSTRAINT "passengers_predefined_boarding_fixed_point_id_company_id_fkey" FOREIGN KEY ("predefined_boarding_fixed_point_id", "company_id") REFERENCES "routing_fixed_points"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "routing_route_points" ADD CONSTRAINT "routing_route_points_fixed_point_id_company_id_fkey" FOREIGN KEY ("fixed_point_id", "company_id") REFERENCES "routing_fixed_points"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
