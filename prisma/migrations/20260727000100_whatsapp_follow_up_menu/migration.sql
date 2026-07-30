ALTER TABLE "whatsapp_conversations"
  ADD COLUMN "follow_up_menu_presented_at" TIMESTAMP(3);

-- Repara conversas pós-orçamento que versões anteriores devolveram ao bot
-- mantendo uma etapa reservada ao atendimento humano.
UPDATE "whatsapp_conversations"
SET
  "department" = 'commercial',
  "flow_step" = 'commercial-follow-up-menu',
  "resume_state" = NULL,
  "resume_flow_step" = NULL,
  "follow_up_menu_presented_at" = NULL,
  "contextual_follow_up_at" = TIMESTAMP '1970-01-01 00:00:00'
WHERE
  "conversation_state" = 'bot-active'
  AND "flow_step" IN ('human-service', 'quote-send-pending')
  AND "request_status" IN ('under-review', 'approved', 'rejected');
