BEGIN;

ALTER TABLE "whatsapp_messages"
  ADD COLUMN "media_storage_key" VARCHAR(700),
  ADD COLUMN "media_mime_type" VARCHAR(160),
  ADD COLUMN "media_size_bytes" INTEGER,
  ADD COLUMN "media_original_name" VARCHAR(255),
  ADD COLUMN "media_sha256" CHAR(64),
  ADD COLUMN "media_stored_at" TIMESTAMP(3);

ALTER TABLE "whatsapp_messages"
  ADD CONSTRAINT "whatsapp_messages_media_metadata_complete_check"
  CHECK (
    (
      "media_storage_key" IS NULL
      AND "media_mime_type" IS NULL
      AND "media_size_bytes" IS NULL
      AND "media_original_name" IS NULL
      AND "media_sha256" IS NULL
      AND "media_stored_at" IS NULL
    )
    OR
    (
      "media_storage_key" IS NOT NULL
      AND "media_mime_type" IS NOT NULL
      AND "media_size_bytes" IS NOT NULL
      AND "media_size_bytes" > 0
      AND "media_original_name" IS NOT NULL
      AND "media_sha256" ~ '^[0-9a-f]{64}$'
      AND "media_stored_at" IS NOT NULL
    )
  );

CREATE INDEX "whatsapp_messages_company_id_media_stored_at_idx"
  ON "whatsapp_messages"("company_id", "media_stored_at");

COMMIT;
