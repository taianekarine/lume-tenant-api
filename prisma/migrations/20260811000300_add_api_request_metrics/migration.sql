CREATE TABLE "api_request_metrics" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "method" VARCHAR(10) NOT NULL,
    "route" VARCHAR(240) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "request_bytes" INTEGER NOT NULL DEFAULT 0,
    "response_bytes" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_request_metrics_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "api_request_metrics_company_id_created_at_idx"
ON "api_request_metrics"("company_id", "created_at" DESC);

CREATE INDEX "api_request_metrics_company_id_user_id_created_at_idx"
ON "api_request_metrics"("company_id", "user_id", "created_at" DESC);

CREATE INDEX "api_request_metrics_company_id_route_created_at_idx"
ON "api_request_metrics"("company_id", "route", "created_at" DESC);

CREATE INDEX "api_request_metrics_company_id_status_code_created_at_idx"
ON "api_request_metrics"("company_id", "status_code", "created_at" DESC);

ALTER TABLE "api_request_metrics"
ADD CONSTRAINT "api_request_metrics_company_id_fkey"
FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "api_request_metrics"
ADD CONSTRAINT "api_request_metrics_user_id_company_id_fkey"
FOREIGN KEY ("user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
