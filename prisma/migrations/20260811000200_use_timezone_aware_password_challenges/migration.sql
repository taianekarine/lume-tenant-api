ALTER TABLE "password_change_challenges"
ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ(3)
USING "expires_at" AT TIME ZONE 'UTC',
ALTER COLUMN "consumed_at" TYPE TIMESTAMPTZ(3)
USING "consumed_at" AT TIME ZONE 'UTC',
ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3)
USING "created_at" AT TIME ZONE 'UTC';
