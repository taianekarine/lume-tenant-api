CREATE TYPE "PasswordChangeReason" AS ENUM ('first-access', 'admin-reset');

ALTER TABLE "users"
ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "profile_picture" BYTEA,
ADD COLUMN "profile_picture_mime" VARCHAR(40);

CREATE TABLE "password_change_challenges" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "reason" "PasswordChangeReason" NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_change_challenges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_password_history" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "password_hash" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_password_history_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_change_challenges_token_hash_key"
ON "password_change_challenges"("token_hash");

CREATE INDEX "password_change_challenges_user_id_company_id_created_at_idx"
ON "password_change_challenges"("user_id", "company_id", "created_at");

CREATE INDEX "password_change_challenges_expires_at_idx"
ON "password_change_challenges"("expires_at");

CREATE INDEX "user_password_history_user_id_company_id_created_at_idx"
ON "user_password_history"("user_id", "company_id", "created_at" DESC);

ALTER TABLE "password_change_challenges"
ADD CONSTRAINT "password_change_challenges_company_id_fkey"
FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "password_change_challenges"
ADD CONSTRAINT "password_change_challenges_user_id_company_id_fkey"
FOREIGN KEY ("user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_password_history"
ADD CONSTRAINT "user_password_history_company_id_fkey"
FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_password_history"
ADD CONSTRAINT "user_password_history_user_id_company_id_fkey"
FOREIGN KEY ("user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
