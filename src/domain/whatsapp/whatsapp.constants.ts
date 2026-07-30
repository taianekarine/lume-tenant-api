import type { Department } from '../access/access.constants';

export const CONVERSATION_STATES = [
  'bot-active',
  'waiting-for-customer',
  'sent-to-human',
  'human-active',
  'closed',
] as const;

export const FLOW_STEPS = [
  'main-menu',
  'commercial-menu',
  'quote-data-collection',
  'quote-summary-confirmation',
  'quote-send-pending',
  'commercial-follow-up-menu',
  'human-service',
  'closed',
] as const;

export const REQUEST_STATUSES = [
  'not-started',
  'collecting-information',
  'waiting-for-customer',
  'under-review',
  'approved',
  'rejected',
  'cancelled',
] as const;

export const ACTIVE_QUOTE_REQUEST_STATUSES = [
  'collecting-information',
  'waiting-for-customer',
  'under-review',
  'approved',
] as const satisfies readonly (typeof REQUEST_STATUSES)[number][];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;

export const DELIVERY_STATUSES = [
  'received',
  'pending',
  'sent',
  'delivered',
  'read',
  'failed',
] as const;

export const MESSAGE_KINDS = [
  'text',
  'image',
  'document',
  'audio',
  'video',
  'sticker',
  'location',
  'contact',
  'unknown',
] as const;

export const QUOTE_PROPOSAL_MAX_PDF_BYTES = 10 * 1024 * 1024;

export const UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT =
  'No momento não consigo ler, ver ou ouvir este tipo de mensagem. Por favor, envie sua mensagem em texto para continuarmos o atendimento.';

export const TRANSITION_NAMES = [
  'present-main-menu',
  'select-commercial',
  'start-department-contact',
  'start-quote',
  'present-quote-summary',
  'correct-quote',
  'confirm-quote',
  'proposal-delivery-confirmed',
  'proposal-response-received',
  'new-quote-request',
  'return-to-main-menu',
  'take-over',
  'return-to-bot',
  'forward',
  'mark-read',
  'close',
  'close-after-rejection',
  'resume-awaited-reply',
  'resume-contextual-contact',
] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];
export type FlowStep = (typeof FLOW_STEPS)[number];
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type TransitionName = (typeof TRANSITION_NAMES)[number];

export interface ConversationSnapshot {
  department: Department;
  conversationState: ConversationState;
  flowStep: FlowStep;
  requestStatus: RequestStatus;
  resumeState: ConversationState | null;
  resumeFlowStep: FlowStep | null;
}
