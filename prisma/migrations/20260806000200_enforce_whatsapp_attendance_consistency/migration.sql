-- Preserve a human owner when the conversation is already routed to a human
-- or when a human-originated proposal is still being delivered.
UPDATE "whatsapp_conversations"
SET "conversation_state" = 'human-active'
WHERE "assigned_to_user_id" IS NOT NULL
  AND (
    "conversation_state" = 'sent-to-human'
    OR (
      "conversation_state" = 'bot-active'
      AND "flow_step" = 'quote-send-pending'
    )
  );

-- States outside active human service cannot retain a human assignment.
UPDATE "whatsapp_conversations"
SET "assigned_to_user_id" = NULL
WHERE "conversation_state" <> 'human-active';

-- Legacy active rows without an owner return to the human queue so that an
-- authorized user can take them over explicitly.
UPDATE "whatsapp_conversations"
SET "conversation_state" = 'sent-to-human',
    "flow_step" = 'human-service'
WHERE "conversation_state" = 'human-active'
  AND "assigned_to_user_id" IS NULL;

ALTER TABLE "whatsapp_conversations"
  DROP CONSTRAINT IF EXISTS "whatsapp_conversations_human_has_assignee";

ALTER TABLE "whatsapp_conversations"
  ADD CONSTRAINT "whatsapp_conversations_attendance_consistent" CHECK (
    (
      "conversation_state" = 'human-active'
      AND "assigned_to_user_id" IS NOT NULL
    )
    OR
    (
      "conversation_state" <> 'human-active'
      AND "assigned_to_user_id" IS NULL
    )
  );
