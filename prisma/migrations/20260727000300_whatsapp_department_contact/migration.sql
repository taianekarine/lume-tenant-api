ALTER TABLE "whatsapp_conversations"
ADD COLUMN "department_contact_option" VARCHAR(2);

ALTER TABLE "whatsapp_messages"
ADD COLUMN "recipient_phone" VARCHAR(20);

UPDATE "whatsapp_messages" AS message
SET "recipient_phone" = contact."phone_normalized"
FROM "whatsapp_contacts" AS contact
WHERE
  message."recipient_phone" IS NULL
  AND message."company_id" = contact."company_id"
  AND message."contact_id" = contact."id"
  AND message."direction" = 'outbound';
