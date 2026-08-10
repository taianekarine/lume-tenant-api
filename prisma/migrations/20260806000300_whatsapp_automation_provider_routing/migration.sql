CREATE TYPE "WhatsAppAutomationProvider" AS ENUM ('n8n', 'api');

CREATE TYPE "WhatsAppAutomationExecutionStatus" AS ENUM (
  'claimed',
  'accepted',
  'succeeded',
  'retryable-failure',
  'terminal-failure'
);

ALTER TABLE "integration_outbox"
ADD COLUMN "processing_provider" "WhatsAppAutomationProvider";
