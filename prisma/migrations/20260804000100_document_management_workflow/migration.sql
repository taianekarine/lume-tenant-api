CREATE TYPE "DocumentAccessMode" AS ENUM ('standard', 'document-portal');
CREATE TYPE "DocumentRequestContext" AS ENUM (
  'admission', 'document-update', 'document-renewal',
  'regularization', 'offboarding', 'other'
);
CREATE TYPE "DocumentRequestStatus" AS ENUM (
  'draft', 'pending-upload', 'partially-submitted', 'submitted',
  'automatic-validation', 'pending-human-review',
  'resubmission-required', 'approved', 'rejected', 'expired', 'cancelled'
);
CREATE TYPE "DocumentItemStatus" AS ENUM (
  'pending-upload', 'submitted', 'automatic-validation',
  'pending-human-review', 'resubmission-required', 'approved',
  'rejected', 'expired', 'cancelled'
);
CREATE TYPE "DocumentRequirement" AS ENUM ('required', 'optional', 'conditional');
CREATE TYPE "DocumentFileSide" AS ENUM ('single', 'front', 'back', 'page');
CREATE TYPE "DocumentValidationStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE "DocumentReviewDecision" AS ENUM ('approved', 'rejected', 'resubmission-required');
CREATE TYPE "DocumentOriginalCheckStatus" AS ENUM ('not-required', 'pending', 'confirmed', 'divergent');

ALTER TABLE "users"
  ADD COLUMN "document_access_mode" "DocumentAccessMode" NOT NULL DEFAULT 'standard';

CREATE TABLE "document_types" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "description" VARCHAR(1000),
  "accepted_mime_types" TEXT[] NOT NULL DEFAULT ARRAY['application/pdf', 'image/jpeg', 'image/png']::TEXT[],
  "max_file_size_bytes" INTEGER NOT NULL DEFAULT 10485760,
  "min_files" INTEGER NOT NULL DEFAULT 1,
  "max_files" INTEGER NOT NULL DEFAULT 1,
  "allows_multiple_pages" BOOLEAN NOT NULL DEFAULT false,
  "requires_front_back" BOOLEAN NOT NULL DEFAULT false,
  "expires" BOOLEAN NOT NULL DEFAULT false,
  "default_validity_days" INTEGER,
  "renewal_lead_days" INTEGER,
  "requires_original" BOOLEAN NOT NULL DEFAULT false,
  "extraction_schema" JSONB NOT NULL DEFAULT '{}',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_types_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_checklist_templates" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "description" VARCHAR(1000),
  "context" "DocumentRequestContext" NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_checklist_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_checklist_items" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "checklist_id" UUID NOT NULL,
  "document_type_id" UUID NOT NULL,
  "requirement" "DocumentRequirement" NOT NULL DEFAULT 'required',
  "position" INTEGER NOT NULL,
  "instructions" VARCHAR(2000),
  "condition" JSONB NOT NULL DEFAULT '{}',
  "config_overrides" JSONB NOT NULL DEFAULT '{}',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_checklist_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_requests" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "subject_user_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "checklist_id" UUID NOT NULL,
  "context" "DocumentRequestContext" NOT NULL,
  "department" "DepartmentCode" NOT NULL DEFAULT 'personnel-department',
  "status" "DocumentRequestStatus" NOT NULL DEFAULT 'draft',
  "deadline" TIMESTAMP(3),
  "notes" VARCHAR(2000),
  "command_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_request_items" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "document_type_id" UUID NOT NULL,
  "renewed_from_item_id" UUID,
  "requirement" "DocumentRequirement" NOT NULL,
  "status" "DocumentItemStatus" NOT NULL DEFAULT 'pending-upload',
  "position" INTEGER NOT NULL,
  "instructions" VARCHAR(2000),
  "config_snapshot" JSONB NOT NULL,
  "due_at" TIMESTAMP(3),
  "valid_until" TIMESTAMP(3),
  "current_version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_request_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_submissions" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "request_item_id" UUID NOT NULL,
  "submitted_by_user_id" UUID NOT NULL,
  "command_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "DocumentItemStatus" NOT NULL DEFAULT 'submitted',
  "extracted_data" JSONB NOT NULL DEFAULT '{}',
  "confirmed_data" JSONB NOT NULL DEFAULT '{}',
  "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_submissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_files" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "submission_id" UUID NOT NULL,
  "uploaded_by_user_id" UUID NOT NULL,
  "side" "DocumentFileSide" NOT NULL DEFAULT 'single',
  "page_number" INTEGER NOT NULL DEFAULT 1,
  "file_name" VARCHAR(255) NOT NULL,
  "mime_type" VARCHAR(80) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "content" BYTEA NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_validations" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "submission_id" UUID NOT NULL,
  "status" "DocumentValidationStatus" NOT NULL DEFAULT 'pending',
  "suggested_document_type_code" VARCHAR(80),
  "result" JSONB NOT NULL DEFAULT '{}',
  "alerts" JSONB NOT NULL DEFAULT '[]',
  "extracted_fields" JSONB NOT NULL DEFAULT '{}',
  "overall_confidence" DOUBLE PRECISION,
  "summary" VARCHAR(2000),
  "provider" VARCHAR(80) NOT NULL DEFAULT 'local-structural',
  "model_version" VARCHAR(120),
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_validations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_reviews" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "submission_id" UUID NOT NULL,
  "reviewed_by_user_id" UUID NOT NULL,
  "command_id" UUID NOT NULL,
  "decision" "DocumentReviewDecision" NOT NULL,
  "reason" VARCHAR(1000),
  "notes" VARCHAR(2000),
  "corrected_fields" JSONB NOT NULL DEFAULT '{}',
  "confirmed_fields" JSONB NOT NULL DEFAULT '{}',
  "original_check_status" "DocumentOriginalCheckStatus" NOT NULL DEFAULT 'not-required',
  "original_checked_at" TIMESTAMP(3),
  "original_observation" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_reviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_status_history" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "request_id" UUID,
  "request_item_id" UUID,
  "submission_id" UUID,
  "actor_user_id" UUID,
  "action" VARCHAR(100) NOT NULL,
  "from_status" VARCHAR(60),
  "to_status" VARCHAR(60) NOT NULL,
  "reason" VARCHAR(1000),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_status_history_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_types_id_company_key" ON "document_types"("id", "company_id");
CREATE UNIQUE INDEX "document_types_company_code_key" ON "document_types"("company_id", "code");
CREATE INDEX "document_types_company_active_name_idx" ON "document_types"("company_id", "active", "name");
CREATE UNIQUE INDEX "document_checklist_templates_id_company_key" ON "document_checklist_templates"("id", "company_id");
CREATE UNIQUE INDEX "document_checklist_templates_company_code_version_key" ON "document_checklist_templates"("company_id", "code", "version");
CREATE INDEX "document_checklist_templates_company_context_active_idx" ON "document_checklist_templates"("company_id", "context", "active");
CREATE UNIQUE INDEX "document_checklist_items_company_checklist_type_key" ON "document_checklist_items"("company_id", "checklist_id", "document_type_id");
CREATE UNIQUE INDEX "document_checklist_items_company_checklist_position_key" ON "document_checklist_items"("company_id", "checklist_id", "position");
CREATE UNIQUE INDEX "document_requests_id_company_key" ON "document_requests"("id", "company_id");
CREATE UNIQUE INDEX "document_requests_company_command_key" ON "document_requests"("company_id", "command_id");
CREATE INDEX "document_requests_company_subject_status_deadline_idx" ON "document_requests"("company_id", "subject_user_id", "status", "deadline");
CREATE INDEX "document_requests_company_department_status_updated_idx" ON "document_requests"("company_id", "department", "status", "updated_at");
CREATE UNIQUE INDEX "document_request_items_id_company_key" ON "document_request_items"("id", "company_id");
CREATE UNIQUE INDEX "document_request_items_company_request_position_key" ON "document_request_items"("company_id", "request_id", "position");
CREATE INDEX "document_request_items_company_status_due_idx" ON "document_request_items"("company_id", "status", "due_at");
CREATE INDEX "document_request_items_company_valid_until_idx" ON "document_request_items"("company_id", "valid_until");
CREATE UNIQUE INDEX "document_submissions_id_company_key" ON "document_submissions"("id", "company_id");
CREATE UNIQUE INDEX "document_submissions_company_command_key" ON "document_submissions"("company_id", "command_id");
CREATE UNIQUE INDEX "document_submissions_company_item_version_key" ON "document_submissions"("company_id", "request_item_id", "version");
CREATE INDEX "document_submissions_company_status_submitted_idx" ON "document_submissions"("company_id", "status", "submitted_at");
CREATE UNIQUE INDEX "document_files_id_company_key" ON "document_files"("id", "company_id");
CREATE UNIQUE INDEX "document_files_company_submission_side_page_key" ON "document_files"("company_id", "submission_id", "side", "page_number");
CREATE INDEX "document_files_company_sha_idx" ON "document_files"("company_id", "sha256");
CREATE UNIQUE INDEX "document_validations_submission_company_key" ON "document_validations"("submission_id", "company_id");
CREATE INDEX "document_validations_company_status_created_idx" ON "document_validations"("company_id", "status", "created_at");
CREATE UNIQUE INDEX "document_reviews_company_command_key" ON "document_reviews"("company_id", "command_id");
CREATE INDEX "document_reviews_company_submission_created_idx" ON "document_reviews"("company_id", "submission_id", "created_at");
CREATE INDEX "document_status_history_company_request_created_idx" ON "document_status_history"("company_id", "request_id", "created_at");
CREATE INDEX "document_status_history_company_item_created_idx" ON "document_status_history"("company_id", "request_item_id", "created_at");
CREATE INDEX "document_status_history_company_submission_created_idx" ON "document_status_history"("company_id", "submission_id", "created_at");

ALTER TABLE "document_types" ADD CONSTRAINT "document_types_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_checklist_templates" ADD CONSTRAINT "document_checklist_templates_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_checklist_templates" ADD CONSTRAINT "document_checklist_templates_creator_fkey" FOREIGN KEY ("created_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_checklist_items" ADD CONSTRAINT "document_checklist_items_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_checklist_items" ADD CONSTRAINT "document_checklist_items_checklist_fkey" FOREIGN KEY ("checklist_id", "company_id") REFERENCES "document_checklist_templates"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_checklist_items" ADD CONSTRAINT "document_checklist_items_type_fkey" FOREIGN KEY ("document_type_id", "company_id") REFERENCES "document_types"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_subject_fkey" FOREIGN KEY ("subject_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_creator_fkey" FOREIGN KEY ("created_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_checklist_fkey" FOREIGN KEY ("checklist_id", "company_id") REFERENCES "document_checklist_templates"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_request_items" ADD CONSTRAINT "document_request_items_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_request_items" ADD CONSTRAINT "document_request_items_request_fkey" FOREIGN KEY ("request_id", "company_id") REFERENCES "document_requests"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_request_items" ADD CONSTRAINT "document_request_items_type_fkey" FOREIGN KEY ("document_type_id", "company_id") REFERENCES "document_types"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_request_items" ADD CONSTRAINT "document_request_items_renewed_from_fkey" FOREIGN KEY ("renewed_from_item_id", "company_id") REFERENCES "document_request_items"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_submissions" ADD CONSTRAINT "document_submissions_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_submissions" ADD CONSTRAINT "document_submissions_item_fkey" FOREIGN KEY ("request_item_id", "company_id") REFERENCES "document_request_items"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_submissions" ADD CONSTRAINT "document_submissions_author_fkey" FOREIGN KEY ("submitted_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_submission_fkey" FOREIGN KEY ("submission_id", "company_id") REFERENCES "document_submissions"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_uploader_fkey" FOREIGN KEY ("uploaded_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_validations" ADD CONSTRAINT "document_validations_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_validations" ADD CONSTRAINT "document_validations_submission_fkey" FOREIGN KEY ("submission_id", "company_id") REFERENCES "document_submissions"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_submission_fkey" FOREIGN KEY ("submission_id", "company_id") REFERENCES "document_submissions"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_reviewer_fkey" FOREIGN KEY ("reviewed_by_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_status_history" ADD CONSTRAINT "document_status_history_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_status_history" ADD CONSTRAINT "document_status_history_request_fkey" FOREIGN KEY ("request_id", "company_id") REFERENCES "document_requests"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_status_history" ADD CONSTRAINT "document_status_history_item_fkey" FOREIGN KEY ("request_item_id", "company_id") REFERENCES "document_request_items"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_status_history" ADD CONSTRAINT "document_status_history_submission_fkey" FOREIGN KEY ("submission_id", "company_id") REFERENCES "document_submissions"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_status_history" ADD CONSTRAINT "document_status_history_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "document_types" ADD CONSTRAINT "document_types_file_count_check" CHECK ("min_files" >= 1 AND "max_files" >= "min_files");
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_size_check" CHECK ("max_file_size_bytes" > 0);
ALTER TABLE "document_request_items" ADD CONSTRAINT "document_request_items_version_check" CHECK ("current_version" >= 0);
ALTER TABLE "document_submissions" ADD CONSTRAINT "document_submissions_version_check" CHECK ("version" > 0);
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_page_check" CHECK ("page_number" > 0 AND "size_bytes" > 0);
