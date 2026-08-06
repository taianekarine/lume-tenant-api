-- Reconcile legacy requests that duplicated a document requirement for the
-- same employee. A later human approval in the dossier satisfies older open
-- copies of the same requirement without duplicating the approved file.
CREATE TEMP TABLE "_document_requirement_reconciliation" AS
SELECT DISTINCT ON (pending_item."id")
  pending_item."id" AS "pending_item_id",
  pending_item."request_id" AS "pending_request_id",
  pending_item."status" AS "pending_status",
  approved_item."id" AS "source_item_id",
  approved_submission."id" AS "source_submission_id",
  approved_review."created_at" AS "approved_at"
FROM "document_request_items" pending_item
INNER JOIN "document_requests" pending_request
  ON pending_request."id" = pending_item."request_id"
 AND pending_request."company_id" = pending_item."company_id"
INNER JOIN "document_request_items" approved_item
  ON approved_item."company_id" = pending_item."company_id"
 AND approved_item."document_type_id" = pending_item."document_type_id"
 AND approved_item."id" <> pending_item."id"
 AND approved_item."status" = 'approved'
INNER JOIN "document_requests" approved_request
  ON approved_request."id" = approved_item."request_id"
 AND approved_request."company_id" = approved_item."company_id"
 AND approved_request."subject_user_id" = pending_request."subject_user_id"
INNER JOIN "document_submissions" approved_submission
  ON approved_submission."request_item_id" = approved_item."id"
 AND approved_submission."company_id" = approved_item."company_id"
 AND approved_submission."status" = 'approved'
INNER JOIN "document_reviews" approved_review
  ON approved_review."submission_id" = approved_submission."id"
 AND approved_review."company_id" = approved_submission."company_id"
 AND approved_review."decision" = 'approved'
WHERE pending_request."status" <> 'cancelled'
  AND pending_item."status" IN (
    'pending-upload',
    'submitted',
    'automatic-validation',
    'pending-human-review',
    'resubmission-required',
    'rejected',
    'expired'
  )
  AND approved_review."created_at" >= pending_item."created_at"
ORDER BY pending_item."id", approved_review."created_at" DESC;

UPDATE "document_submissions" submission
SET
  "status" = 'cancelled',
  "updated_at" = CURRENT_TIMESTAMP
FROM "_document_requirement_reconciliation" reconciliation
WHERE submission."request_item_id" = reconciliation."pending_item_id"
  AND submission."status" IN (
    'submitted',
    'automatic-validation',
    'pending-human-review',
    'resubmission-required',
    'rejected',
    'expired'
  );

UPDATE "document_request_items" item
SET
  "status" = 'waived',
  "config_snapshot" = item."config_snapshot" || jsonb_build_object(
    'satisfiedBySubmissionId', reconciliation."source_submission_id"::text,
    'satisfiedByRequestItemId', reconciliation."source_item_id"::text,
    'satisfiedAt', reconciliation."approved_at"::text
  ),
  "updated_at" = CURRENT_TIMESTAMP
FROM "_document_requirement_reconciliation" reconciliation
WHERE item."id" = reconciliation."pending_item_id";

INSERT INTO "document_status_history" (
  "id",
  "company_id",
  "request_id",
  "request_item_id",
  "actor_user_id",
  "action",
  "from_status",
  "to_status",
  "reason",
  "metadata",
  "created_at"
)
SELECT
  gen_random_uuid(),
  item."company_id",
  reconciliation."pending_request_id",
  reconciliation."pending_item_id",
  NULL,
  'item.satisfied-by-dossier-document',
  reconciliation."pending_status"::text,
  'waived',
  'Exigência conciliada com documento do mesmo tipo aprovado posteriormente no dossiê.',
  jsonb_build_object(
    'sourceSubmissionId', reconciliation."source_submission_id"::text,
    'sourceRequestItemId', reconciliation."source_item_id"::text,
    'migration', '20260805000400_reconcile_duplicate_document_requirements'
  ),
  CURRENT_TIMESTAMP
FROM "_document_requirement_reconciliation" reconciliation
INNER JOIN "document_request_items" item
  ON item."id" = reconciliation."pending_item_id";

UPDATE "document_requests" request
SET
  "status" = 'approved',
  "completed_at" = COALESCE(request."completed_at", CURRENT_TIMESTAMP),
  "version" = request."version" + 1,
  "updated_at" = CURRENT_TIMESTAMP
WHERE request."id" IN (
  SELECT DISTINCT "pending_request_id"
  FROM "_document_requirement_reconciliation"
)
  AND EXISTS (
    SELECT 1
    FROM "document_request_items" item
    WHERE item."request_id" = request."id"
      AND item."company_id" = request."company_id"
      AND item."requirement" <> 'optional'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "document_request_items" item
    WHERE item."request_id" = request."id"
      AND item."company_id" = request."company_id"
      AND item."requirement" <> 'optional'
      AND item."status" NOT IN ('approved', 'waived')
  );

DROP TABLE "_document_requirement_reconciliation";
