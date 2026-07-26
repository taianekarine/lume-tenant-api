-- CreateEnum
CREATE TYPE "DepartmentCode" AS ENUM ('human-resources', 'personnel-department', 'commercial', 'purchasing', 'maintenance', 'monitoring', 'operations', 'cleaning', 'financial', 'information-technology');

-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('bot-active', 'waiting-for-customer', 'sent-to-human', 'human-active', 'closed');

-- CreateEnum
CREATE TYPE "FlowStep" AS ENUM ('main-menu', 'commercial-menu', 'quote-data-collection', 'quote-summary-confirmation', 'quote-send-pending', 'commercial-follow-up-menu', 'human-service', 'closed');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('not-started', 'collecting-information', 'waiting-for-customer', 'under-review', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('received', 'pending', 'sent', 'delivered', 'read', 'failed');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('text', 'image', 'document', 'audio', 'video', 'sticker', 'location', 'contact', 'unknown');

-- CreateEnum
CREATE TYPE "MessageAttemptStatus" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "TransitionActorType" AS ENUM ('user', 'n8n', 'webhook', 'system');

-- CreateEnum
CREATE TYPE "IntegrationOutboxStatus" AS ENUM ('pending', 'processing', 'delivered', 'dead');

-- CreateEnum
CREATE TYPE "WhatsAppProviderType" AS ENUM ('evolution');

-- CreateEnum
CREATE TYPE "ServiceIdentityType" AS ENUM ('n8n');

-- CreateTable
CREATE TABLE "tenant_departments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" "DepartmentCode" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_providers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "type" "WhatsAppProviderType" NOT NULL DEFAULT 'evolution',
    "base_url" VARCHAR(500) NOT NULL,
    "api_key_hash" CHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_channels" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "phone_number" VARCHAR(16) NOT NULL,
    "instance_name" VARCHAR(120) NOT NULL,
    "webhook_secret_hash" CHAR(64) NOT NULL,
    "ignore_groups" BOOLEAN NOT NULL DEFAULT true,
    "ignore_from_me" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_contacts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "phone_normalized" VARCHAR(16) NOT NULL,
    "display_name" VARCHAR(160),
    "profile_picture_url" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_conversations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "department" "DepartmentCode" NOT NULL DEFAULT 'commercial',
    "conversation_state" "ConversationState" NOT NULL DEFAULT 'bot-active',
    "flow_step" "FlowStep" NOT NULL DEFAULT 'main-menu',
    "request_status" "RequestStatus" NOT NULL DEFAULT 'not-started',
    "resume_state" "ConversationState",
    "assigned_to_user_id" UUID,
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "last_inbound_at" TIMESTAMP(3),
    "last_outbound_at" TIMESTAMP(3),
    "last_message_preview" VARCHAR(240),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "provider_message_id" VARCHAR(160),
    "direction" "MessageDirection" NOT NULL,
    "delivery_status" "DeliveryStatus" NOT NULL,
    "kind" "MessageKind" NOT NULL DEFAULT 'text',
    "text" TEXT,
    "media" JSONB,
    "correlation_id" VARCHAR(120) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_message_attempts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" "MessageAttemptStatus" NOT NULL DEFAULT 'pending',
    "provider_message_id" VARCHAR(160),
    "error_code" VARCHAR(80),
    "error_message" VARCHAR(500),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_message_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_conversation_transitions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "command_id" VARCHAR(120) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "expected_version" INTEGER NOT NULL,
    "resulting_version" INTEGER NOT NULL,
    "actor_type" "TransitionActorType" NOT NULL,
    "actor_user_id" UUID,
    "from_department" "DepartmentCode" NOT NULL,
    "to_department" "DepartmentCode" NOT NULL,
    "from_state" "ConversationState" NOT NULL,
    "to_state" "ConversationState" NOT NULL,
    "from_flow_step" "FlowStep" NOT NULL,
    "to_flow_step" "FlowStep" NOT NULL,
    "from_request_status" "RequestStatus" NOT NULL,
    "to_request_status" "RequestStatus" NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_conversation_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_requests" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'collecting-information',
    "contact_name" VARCHAR(160),
    "document" VARCHAR(20),
    "email" VARCHAR(254),
    "service_type" VARCHAR(120),
    "origin" VARCHAR(300),
    "destination" VARCHAR(300),
    "departure_at" TIMESTAMP(3),
    "return_at" TIMESTAMP(3),
    "passenger_count" INTEGER,
    "vehicle_type" VARCHAR(120),
    "vehicle_at_disposal" BOOLEAN,
    "local_transfers" BOOLEAN,
    "notes" TEXT,
    "structured_data" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quote_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_inbox" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "channel_id" UUID,
    "source" VARCHAR(80) NOT NULL,
    "external_event_id" VARCHAR(160) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "correlation_id" VARCHAR(120) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "integration_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_outbox" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "topic" VARCHAR(100) NOT NULL,
    "aggregate_type" VARCHAR(60) NOT NULL,
    "aggregate_id" VARCHAR(100) NOT NULL,
    "correlation_id" VARCHAR(120) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "IntegrationOutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "lock_id" UUID,
    "delivered_at" TIMESTAMP(3),
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_identities" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "type" "ServiceIdentityType" NOT NULL DEFAULT 'n8n',
    "name" VARCHAR(80) NOT NULL,
    "key_id" UUID NOT NULL,
    "secret_hash" CHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_departments_company_id_idx" ON "tenant_departments"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_departments_company_id_code_key" ON "tenant_departments"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_departments_id_company_id_key" ON "tenant_departments"("id", "company_id");

-- CreateIndex
CREATE INDEX "whatsapp_providers_company_id_enabled_idx" ON "whatsapp_providers"("company_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_providers_company_id_name_key" ON "whatsapp_providers"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_providers_id_company_id_key" ON "whatsapp_providers"("id", "company_id");

-- CreateIndex
CREATE INDEX "whatsapp_channels_company_id_enabled_idx" ON "whatsapp_channels"("company_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_channels_company_id_phone_number_key" ON "whatsapp_channels"("company_id", "phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_channels_company_id_provider_id_instance_name_key" ON "whatsapp_channels"("company_id", "provider_id", "instance_name");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_channels_id_company_id_key" ON "whatsapp_channels"("id", "company_id");

-- CreateIndex
CREATE INDEX "whatsapp_contacts_company_id_display_name_idx" ON "whatsapp_contacts"("company_id", "display_name");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_contacts_company_id_phone_normalized_key" ON "whatsapp_contacts"("company_id", "phone_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_contacts_id_company_id_key" ON "whatsapp_contacts"("id", "company_id");

-- CreateIndex
CREATE INDEX "whatsapp_conversations_company_id_updated_at_idx" ON "whatsapp_conversations"("company_id", "updated_at");

-- CreateIndex
CREATE INDEX "whatsapp_conversations_company_id_conversation_state_update_idx" ON "whatsapp_conversations"("company_id", "conversation_state", "updated_at");

-- CreateIndex
CREATE INDEX "whatsapp_conversations_company_id_channel_id_contact_id_clo_idx" ON "whatsapp_conversations"("company_id", "channel_id", "contact_id", "closed_at");

-- CreateIndex
CREATE INDEX "whatsapp_conversations_company_id_id_version_idx" ON "whatsapp_conversations"("company_id", "id", "version");

-- CreateIndex
CREATE INDEX "whatsapp_conversations_assigned_to_user_id_company_id_idx" ON "whatsapp_conversations"("assigned_to_user_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_conversations_id_company_id_key" ON "whatsapp_conversations"("id", "company_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_company_id_conversation_id_occurred_at_id_idx" ON "whatsapp_messages"("company_id", "conversation_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_company_id_delivery_status_created_at_idx" ON "whatsapp_messages"("company_id", "delivery_status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_company_id_channel_id_provider_message_id_key" ON "whatsapp_messages"("company_id", "channel_id", "provider_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_company_id_correlation_id_key" ON "whatsapp_messages"("company_id", "correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_id_company_id_key" ON "whatsapp_messages"("id", "company_id");

-- CreateIndex
CREATE INDEX "whatsapp_message_attempts_company_id_status_started_at_idx" ON "whatsapp_message_attempts"("company_id", "status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_message_attempts_company_id_message_id_attempt_num_key" ON "whatsapp_message_attempts"("company_id", "message_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_message_attempts_id_company_id_key" ON "whatsapp_message_attempts"("id", "company_id");

-- CreateIndex
CREATE INDEX "whatsapp_conversation_transitions_company_id_conversation_i_idx" ON "whatsapp_conversation_transitions"("company_id", "conversation_id", "resulting_version");

-- CreateIndex
CREATE INDEX "whatsapp_conversation_transitions_actor_user_id_company_id__idx" ON "whatsapp_conversation_transitions"("actor_user_id", "company_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_conversation_transitions_company_id_command_id_key" ON "whatsapp_conversation_transitions"("company_id", "command_id");

-- CreateIndex
CREATE INDEX "quote_requests_company_id_status_updated_at_idx" ON "quote_requests"("company_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "quote_requests_company_id_id_version_idx" ON "quote_requests"("company_id", "id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "quote_requests_company_id_conversation_id_sequence_key" ON "quote_requests"("company_id", "conversation_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "quote_requests_id_company_id_key" ON "quote_requests"("id", "company_id");

-- CreateIndex
CREATE INDEX "integration_inbox_company_id_received_at_idx" ON "integration_inbox"("company_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_inbox_company_id_source_external_event_id_key" ON "integration_inbox"("company_id", "source", "external_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_inbox_company_id_correlation_id_key" ON "integration_inbox"("company_id", "correlation_id");

-- CreateIndex
CREATE INDEX "integration_outbox_status_available_at_locked_at_idx" ON "integration_outbox"("status", "available_at", "locked_at");

-- CreateIndex
CREATE INDEX "integration_outbox_company_id_created_at_idx" ON "integration_outbox"("company_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_outbox_company_id_correlation_id_key" ON "integration_outbox"("company_id", "correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_identities_key_id_key" ON "service_identities"("key_id");

-- CreateIndex
CREATE INDEX "service_identities_company_id_enabled_idx" ON "service_identities"("company_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "service_identities_company_id_type_name_key" ON "service_identities"("company_id", "type", "name");

-- CreateIndex
CREATE UNIQUE INDEX "service_identities_id_company_id_key" ON "service_identities"("id", "company_id");

-- AddForeignKey
ALTER TABLE "tenant_departments" ADD CONSTRAINT "tenant_departments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_providers" ADD CONSTRAINT "whatsapp_providers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_channels" ADD CONSTRAINT "whatsapp_channels_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_channels" ADD CONSTRAINT "whatsapp_channels_provider_id_company_id_fkey" FOREIGN KEY ("provider_id", "company_id") REFERENCES "whatsapp_providers"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_channel_id_company_id_fkey" FOREIGN KEY ("channel_id", "company_id") REFERENCES "whatsapp_channels"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_contact_id_company_id_fkey" FOREIGN KEY ("contact_id", "company_id") REFERENCES "whatsapp_contacts"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_assigned_to_user_id_company_id_fkey" FOREIGN KEY ("assigned_to_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_conversation_id_company_id_fkey" FOREIGN KEY ("conversation_id", "company_id") REFERENCES "whatsapp_conversations"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_channel_id_company_id_fkey" FOREIGN KEY ("channel_id", "company_id") REFERENCES "whatsapp_channels"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_contact_id_company_id_fkey" FOREIGN KEY ("contact_id", "company_id") REFERENCES "whatsapp_contacts"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_message_attempts" ADD CONSTRAINT "whatsapp_message_attempts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_message_attempts" ADD CONSTRAINT "whatsapp_message_attempts_message_id_company_id_fkey" FOREIGN KEY ("message_id", "company_id") REFERENCES "whatsapp_messages"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_conversation_transitions" ADD CONSTRAINT "whatsapp_conversation_transitions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_conversation_transitions" ADD CONSTRAINT "whatsapp_conversation_transitions_conversation_id_company__fkey" FOREIGN KEY ("conversation_id", "company_id") REFERENCES "whatsapp_conversations"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_conversation_transitions" ADD CONSTRAINT "whatsapp_conversation_transitions_actor_user_id_company_id_fkey" FOREIGN KEY ("actor_user_id", "company_id") REFERENCES "users"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_conversation_id_company_id_fkey" FOREIGN KEY ("conversation_id", "company_id") REFERENCES "whatsapp_conversations"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_inbox" ADD CONSTRAINT "integration_inbox_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_inbox" ADD CONSTRAINT "integration_inbox_channel_id_company_id_fkey" FOREIGN KEY ("channel_id", "company_id") REFERENCES "whatsapp_channels"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_outbox" ADD CONSTRAINT "integration_outbox_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_identities" ADD CONSTRAINT "service_identities_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Domain and concurrency invariants that Prisma cannot express.
ALTER TABLE "whatsapp_conversations"
  ADD CONSTRAINT "whatsapp_conversations_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "whatsapp_conversations_unread_count_non_negative" CHECK ("unread_count" >= 0),
  ADD CONSTRAINT "whatsapp_conversations_human_has_assignee" CHECK ("conversation_state" <> 'human-active' OR "assigned_to_user_id" IS NOT NULL);

ALTER TABLE "whatsapp_messages"
  ADD CONSTRAINT "whatsapp_messages_content_present" CHECK ("text" IS NOT NULL OR "media" IS NOT NULL OR "kind" = 'unknown'),
  ADD CONSTRAINT "whatsapp_messages_inbound_received" CHECK ("direction" <> 'inbound' OR "delivery_status" = 'received');

ALTER TABLE "whatsapp_message_attempts"
  ADD CONSTRAINT "whatsapp_message_attempts_number_positive" CHECK ("attempt_number" > 0);

ALTER TABLE "quote_requests"
  ADD CONSTRAINT "quote_requests_sequence_positive" CHECK ("sequence" > 0),
  ADD CONSTRAINT "quote_requests_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "quote_requests_passenger_count_positive" CHECK ("passenger_count" IS NULL OR "passenger_count" > 0);

ALTER TABLE "integration_outbox"
  ADD CONSTRAINT "integration_outbox_attempts_valid" CHECK ("attempts" >= 0 AND "max_attempts" > 0 AND "attempts" <= "max_attempts");

CREATE FUNCTION "reject_whatsapp_transition_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'whatsapp_conversation_transitions is append-only';
END;
$$;

CREATE TRIGGER "whatsapp_transitions_append_only"
BEFORE UPDATE OR DELETE ON "whatsapp_conversation_transitions"
FOR EACH ROW EXECUTE FUNCTION "reject_whatsapp_transition_mutation"();
