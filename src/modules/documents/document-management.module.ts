import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DOCUMENT_REVIEW_AGENT } from '../../application/contracts/document-review-agent';
import { DocumentManagementUseCase } from '../../application/use-cases/documents/document-management.use-case';
import {
  FallbackDocumentReviewAgent,
  LocalStructuralReviewAgent,
  OpenAiDocumentReviewAgent,
} from '../../infra/documents/document-review-agents';
import { DocumentManagementController } from './document-management.controller';

@Module({
  controllers: [DocumentManagementController],
  providers: [
    {
      provide: DOCUMENT_REVIEW_AGENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const enabled = config.get<boolean>('DOCUMENT_REVIEW_ENABLED') === true;
        const provider = config.get<string>('DOCUMENT_REVIEW_PROVIDER');
        const apiKey = config.get<string>('OPENAI_API_KEY') ?? '';
        if (!enabled || provider !== 'openai' || !apiKey) {
          return new LocalStructuralReviewAgent();
        }
        return new FallbackDocumentReviewAgent(
          new OpenAiDocumentReviewAgent({
            apiKey,
            model:
              config.get<string>('OPENAI_DOCUMENT_MODEL') ?? 'gpt-5.6-terra',
            timeoutMs:
              config.get<number>('OPENAI_DOCUMENT_TIMEOUT_MS') ?? 90_000,
            maxAttempts:
              config.get<number>('OPENAI_DOCUMENT_MAX_ATTEMPTS') ?? 3,
            baseUrl: config.get<string>('OPENAI_API_BASE_URL') || undefined,
          }),
        );
      },
    },
    DocumentManagementUseCase,
  ],
  exports: [DocumentManagementUseCase],
})
export class DocumentManagementModule {}
