INSERT INTO "whatsapp_conversation_transitions" (
  "id",
  "company_id",
  "conversation_id",
  "command_id",
  "command_fingerprint",
  "name",
  "expected_version",
  "resulting_version",
  "actor_type",
  "actor_user_id",
  "from_department",
  "to_department",
  "from_state",
  "to_state",
  "from_flow_step",
  "to_flow_step",
  "from_request_status",
  "to_request_status",
  "metadata",
  "result_snapshot"
)
SELECT
  gen_random_uuid(),
  conversation."company_id",
  conversation."id",
  'migration:20260727000200:' || conversation."id",
  md5('whatsapp-follow-up-audit-repair:' || conversation."id")
    || md5(conversation."version"::text),
  'resume-contextual-contact',
  conversation."version",
  conversation."version" + 1,
  'system',
  NULL,
  latest_transition."to_department",
  conversation."department",
  latest_transition."to_state",
  conversation."conversation_state",
  latest_transition."to_flow_step",
  conversation."flow_step",
  latest_transition."to_request_status",
  conversation."request_status",
  jsonb_build_object(
    'source', 'migration',
    'reason', 'normalize-return-to-bot-follow-up'
  ),
  jsonb_build_object(
    'id', conversation."id",
    'department', conversation."department",
    'conversationState', conversation."conversation_state",
    'flowStep', conversation."flow_step",
    'requestStatus', conversation."request_status",
    'resumeState', NULL,
    'resumeFlowStep', NULL,
    'version', conversation."version" + 1
  )
FROM "whatsapp_conversations" AS conversation
JOIN LATERAL (
  SELECT
    transition."to_department",
    transition."to_state",
    transition."to_flow_step",
    transition."to_request_status"
  FROM "whatsapp_conversation_transitions" AS transition
  WHERE
    transition."company_id" = conversation."company_id"
    AND transition."conversation_id" = conversation."id"
    AND transition."resulting_version" = conversation."version"
  ORDER BY transition."created_at" DESC, transition."id" DESC
  LIMIT 1
) AS latest_transition ON TRUE
WHERE
  conversation."conversation_state" = 'bot-active'
  AND conversation."flow_step" = 'commercial-follow-up-menu'
  AND conversation."request_status" IN ('under-review', 'approved', 'rejected')
  AND conversation."resume_state" IS NULL
  AND conversation."resume_flow_step" IS NULL
  AND conversation."follow_up_menu_presented_at" IS NULL
  AND conversation."contextual_follow_up_at" =
    TIMESTAMP '1970-01-01 00:00:00'
  AND latest_transition."to_flow_step" IN (
    'human-service',
    'quote-send-pending'
  );

UPDATE "whatsapp_conversations" AS conversation
SET "version" = conversation."version" + 1
WHERE EXISTS (
  SELECT 1
  FROM "whatsapp_conversation_transitions" AS transition
  WHERE
    transition."company_id" = conversation."company_id"
    AND transition."conversation_id" = conversation."id"
    AND transition."command_id" =
      'migration:20260727000200:' || conversation."id"
    AND transition."resulting_version" = conversation."version" + 1
);
