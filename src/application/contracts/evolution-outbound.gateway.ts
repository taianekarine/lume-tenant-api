export type EvolutionTextPayloadMode =
  'number-text' | 'legacy-text' | 'textMessage';

interface EvolutionOutboundBaseInput {
  readonly recipientPhone: string;
}

export interface EvolutionOutboundTextInput extends EvolutionOutboundBaseInput {
  readonly kind: 'text';
  readonly text: string;
}

export interface EvolutionOutboundDocumentInput extends EvolutionOutboundBaseInput {
  readonly kind: 'document';
  readonly fileName: string;
  readonly mimeType: string;
  readonly content: Buffer;
  readonly caption?: string;
}

export interface EvolutionOutboundMediaInput extends EvolutionOutboundBaseInput {
  readonly kind: 'media';
  readonly mediaType: 'image' | 'video' | 'audio' | 'document';
  readonly fileName: string;
  readonly mimeType: string;
  readonly content: Buffer;
  readonly caption?: string;
}

export type EvolutionOutboundInput =
  | EvolutionOutboundTextInput
  | EvolutionOutboundDocumentInput
  | EvolutionOutboundMediaInput;

export interface EvolutionOutboundConfirmedResult {
  readonly outcome: 'confirmed';
  readonly deliveryStatus: 'sent';
  readonly providerMessageId?: string;
  readonly httpStatus: number;
  readonly requiresReconciliation: false;
}

export interface EvolutionOutboundNotSentResult {
  readonly outcome: 'not-sent';
  readonly deliveryStatus: 'pending';
  readonly errorCode:
    'EVOLUTION_CONFIGURATION_INVALID' | 'EVOLUTION_OUTBOUND_INVALID';
  readonly errorMessage: string;
  readonly requiresReconciliation: false;
}

export interface EvolutionOutboundAmbiguousResult {
  readonly outcome: 'ambiguous';
  readonly deliveryStatus: 'pending';
  readonly errorCode:
    | 'EVOLUTION_DISPATCH_TIMEOUT'
    | 'EVOLUTION_DISPATCH_NETWORK_ERROR'
    | 'EVOLUTION_DISPATCH_UNCONFIRMED';
  readonly errorMessage: string;
  readonly httpStatus?: number;
  readonly requiresReconciliation: true;
}

export type EvolutionOutboundResult =
  | EvolutionOutboundConfirmedResult
  | EvolutionOutboundNotSentResult
  | EvolutionOutboundAmbiguousResult;

export abstract class EvolutionOutboundGateway {
  abstract send(
    input: EvolutionOutboundInput,
  ): Promise<EvolutionOutboundResult>;
}
