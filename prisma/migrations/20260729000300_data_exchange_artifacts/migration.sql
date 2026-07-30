CREATE TYPE "DataExchangeArtifactKind" AS ENUM ('upload', 'conversion');

CREATE TABLE "data_exchange_artifacts" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "uploaded_by_user_id" UUID NOT NULL,
  "source_artifact_id" UUID,
  "kind" "DataExchangeArtifactKind" NOT NULL,
  "command_id" UUID NOT NULL,
  "request_fingerprint" CHAR(64) NOT NULL,
  "file_name" VARCHAR(255) NOT NULL,
  "mime_type" VARCHAR(160) NOT NULL,
  "extension" VARCHAR(20) NOT NULL,
  "format" VARCHAR(40) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "content" BYTEA NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "data_exchange_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "data_exchange_artifacts_size_check"
    CHECK ("size_bytes" > 0),
  CONSTRAINT "data_exchange_artifacts_sha256_check"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "data_exchange_artifacts_fingerprint_check"
    CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "data_exchange_artifacts_id_company_key"
  ON "data_exchange_artifacts"("id", "company_id");

CREATE UNIQUE INDEX "data_exchange_artifacts_company_command_key"
  ON "data_exchange_artifacts"("company_id", "command_id");

CREATE INDEX "data_exchange_artifacts_company_created_idx"
  ON "data_exchange_artifacts"("company_id", "created_at");

CREATE INDEX "data_exchange_artifacts_company_expires_idx"
  ON "data_exchange_artifacts"("company_id", "expires_at");

CREATE INDEX "data_exchange_artifacts_company_sha256_idx"
  ON "data_exchange_artifacts"("company_id", "sha256");

CREATE INDEX "data_exchange_artifacts_source_company_created_idx"
  ON "data_exchange_artifacts"(
    "source_artifact_id",
    "company_id",
    "created_at"
  );

CREATE INDEX "data_exchange_artifacts_uploader_company_created_idx"
  ON "data_exchange_artifacts"(
    "uploaded_by_user_id",
    "company_id",
    "created_at"
  );

ALTER TABLE "data_exchange_artifacts"
  ADD CONSTRAINT "data_exchange_artifacts_company_fkey"
  FOREIGN KEY ("company_id")
  REFERENCES "companies"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "data_exchange_artifacts"
  ADD CONSTRAINT "data_exchange_artifacts_uploader_company_fkey"
  FOREIGN KEY ("uploaded_by_user_id", "company_id")
  REFERENCES "users"("id", "company_id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "data_exchange_artifacts"
  ADD CONSTRAINT "data_exchange_artifacts_source_company_fkey"
  FOREIGN KEY ("source_artifact_id", "company_id")
  REFERENCES "data_exchange_artifacts"("id", "company_id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
