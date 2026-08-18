ALTER TABLE "whatsapp_contacts"
ADD COLUMN "phone_display" VARCHAR(24),
ADD COLUMN "is_saved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "name_needs_review" BOOLEAN NOT NULL DEFAULT false;

UPDATE "whatsapp_contacts"
SET "phone_display" = CASE
  WHEN "phone_normalized" ~ '^55[0-9]{11}$' THEN
    '(' || substring("phone_normalized" FROM 3 FOR 2) || ') ' ||
    substring("phone_normalized" FROM 5 FOR 5) || '-' ||
    substring("phone_normalized" FROM 10 FOR 4)
  WHEN "phone_normalized" ~ '^55[0-9]{10}$' THEN
    '(' || substring("phone_normalized" FROM 3 FOR 2) || ') ' ||
    substring("phone_normalized" FROM 5 FOR 4) || '-' ||
    substring("phone_normalized" FROM 9 FOR 4)
  ELSE '+' || "phone_normalized"
END;

UPDATE "whatsapp_contacts"
SET "display_name" = "phone_display"
WHERE "display_name" IS NULL
   OR "display_name" = "phone_normalized";

ALTER TABLE "whatsapp_contacts"
ALTER COLUMN "phone_display" SET NOT NULL;

CREATE INDEX "whatsapp_contacts_company_id_is_saved_name_needs_review_display_name_idx"
ON "whatsapp_contacts"(
  "company_id",
  "is_saved",
  "name_needs_review",
  "display_name"
);
