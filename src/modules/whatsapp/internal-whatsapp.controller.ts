import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import {
  ClaimEvolutionDispatchUseCase,
  CompleteOutboxExecutionUseCase,
  CreateOutboundWhatsAppUseCase,
  PatchQuoteRequestUseCase,
  QueryWhatsAppUseCase,
  QuoteProposalUseCase,
  ReconcileAutomationOutboxUseCase,
  RecordEvolutionResultUseCase,
  TransitionWhatsAppConversationUseCase,
} from '../../application/use-cases/whatsapp/whatsapp.use-cases';
import {
  CurrentService,
  type ServicePrincipal,
} from '../../shared/http/decorators/current-service.decorator';
import { Public } from '../../shared/http/decorators/public.decorator';
import { ServiceIdentityGuard } from '../../shared/http/guards/service-identity.guard';
import {
  AutomationBatchQueryDto,
  ClaimEvolutionDispatchDto,
  CompleteOutboxExecutionDto,
  CreateOutboundMessageDto,
  EvolutionResultDto,
  PatchQuoteRequestDto,
  ReconcileAutomationOutboxDto,
  TransitionConversationDto,
} from './dto/whatsapp.dto';
import {
  dateOnlyFromDateTime,
  parseDateOnly,
} from '../../domain/whatsapp/quote-schedule';

@ApiTags('WhatsApp interno')
@ApiBearerAuth('serviceBearer')
@Public()
@UseGuards(ServiceIdentityGuard)
@Controller('internal/whatsapp')
export class InternalWhatsAppController {
  constructor(
    private readonly transitionConversation: TransitionWhatsAppConversationUseCase,
    private readonly patchQuote: PatchQuoteRequestUseCase,
    private readonly createOutbound: CreateOutboundWhatsAppUseCase,
    private readonly claimEvolutionDispatchUseCase: ClaimEvolutionDispatchUseCase,
    private readonly evolutionResult: RecordEvolutionResultUseCase,
    private readonly completeOutbox: CompleteOutboxExecutionUseCase,
    private readonly reconcileOutbox: ReconcileAutomationOutboxUseCase,
    private readonly query: QueryWhatsAppUseCase,
    private readonly proposals: QuoteProposalUseCase,
  ) {}

  @Post('conversations/:conversationId/transitions')
  @ApiOkResponse({
    description: 'Transição validada a partir da origem persistida.',
  })
  transition(
    @CurrentService() service: ServicePrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() body: TransitionConversationDto,
  ) {
    return this.transitionConversation.execute({
      ...body,
      companyId: service.companyId,
      conversationId,
      actorType: 'system',
    });
  }

  @Patch('quote-requests/:quoteRequestId')
  patchQuoteRequest(
    @CurrentService() service: ServicePrincipal,
    @Param('quoteRequestId', new ParseUUIDPipe()) quoteRequestId: string,
    @Body() body: PatchQuoteRequestDto,
  ) {
    const departureAt =
      body.departureAt === undefined
        ? undefined
        : body.departureAt === null
          ? null
          : /^\d{4}-\d{2}-\d{2}$/.test(body.departureAt)
            ? null
            : new Date(body.departureAt);
    const returnAt =
      body.returnAt === undefined
        ? undefined
        : body.returnAt === null
          ? null
          : /^\d{4}-\d{2}-\d{2}$/.test(body.returnAt)
            ? null
            : new Date(body.returnAt);
    return this.patchQuote.execute(service.companyId, quoteRequestId, {
      ...body,
      departureDate:
        body.departureDate === undefined
          ? body.departureAt && /^\d{4}-\d{2}-\d{2}$/.test(body.departureAt)
            ? parseDateOnly(body.departureAt, 'departureAt')
            : departureAt instanceof Date
              ? dateOnlyFromDateTime(departureAt)
              : undefined
          : body.departureDate === null
            ? null
            : parseDateOnly(body.departureDate, 'departureDate'),
      departureAt,
      returnDate:
        body.returnDate === undefined
          ? body.returnAt && /^\d{4}-\d{2}-\d{2}$/.test(body.returnAt)
            ? parseDateOnly(body.returnAt, 'returnAt')
            : returnAt instanceof Date
              ? dateOnlyFromDateTime(returnAt)
              : undefined
          : body.returnDate === null
            ? null
            : parseDateOnly(body.returnDate, 'returnDate'),
      returnAt,
    });
  }

  @Post('conversations/:conversationId/messages/outbound')
  createPendingOutbound(
    @CurrentService() service: ServicePrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() body: CreateOutboundMessageDto,
  ) {
    return this.createOutbound.execute({
      ...body,
      automatic: true,
      companyId: service.companyId,
      conversationId,
    });
  }

  @Post('messages/:messageId/evolution-dispatch-claims')
  claimEvolutionDispatch(
    @CurrentService() service: ServicePrincipal,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @Body() body: ClaimEvolutionDispatchDto,
  ) {
    return this.claimEvolutionDispatchUseCase.execute({
      ...body,
      companyId: service.companyId,
      messageId,
      ownerId: service.id,
    });
  }

  @Post('messages/:messageId/evolution-result')
  recordResult(
    @CurrentService() service: ServicePrincipal,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @Body() body: EvolutionResultDto,
  ) {
    return this.evolutionResult.execute({
      ...body,
      companyId: service.companyId,
      messageId,
    });
  }

  @Post('outbox-events/:eventId/completions')
  completeOutboxExecution(
    @CurrentService() service: ServicePrincipal,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Body() body: CompleteOutboxExecutionDto,
  ) {
    return this.completeOutbox.execute({
      ...body,
      companyId: service.companyId,
      eventId,
    });
  }

  @Post('outbox-events/:eventId/reconciliations')
  @ApiOkResponse({
    description:
      'Reconcilia um evento isolado mediante evidência operacional, sem repetir efeitos durante a requisição.',
  })
  reconcileOutboxEvent(
    @CurrentService() service: ServicePrincipal,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Body() body: ReconcileAutomationOutboxDto,
  ) {
    return this.reconcileOutbox.execute({
      ...body,
      companyId: service.companyId,
      eventId,
      serviceIdentityId: service.id,
      serviceIdentityName: service.name,
    });
  }

  @Get('conversations/:conversationId')
  @ApiOkResponse({
    description:
      'Estado atualizado para recuperação após conflito expectedVersion.',
  })
  getState(
    @CurrentService() service: ServicePrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
  ) {
    return this.query.getConversation(service.companyId, conversationId);
  }

  @Get('conversations/:conversationId/automation-batch')
  @ApiOkResponse({
    description:
      'Lote durável de mensagens inbound persistidas durante a janela de automação.',
  })
  getAutomationBatch(
    @CurrentService() service: ServicePrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Query() query: AutomationBatchQueryDto,
  ) {
    return this.query.getAutomationBatch(
      service.companyId,
      conversationId,
      query.sourceEventId,
      query.windowSeconds,
    );
  }

  @Get('proposal-documents/:documentId/content')
  async getProposalDocument(
    @CurrentService() service: ServicePrincipal,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const document = (await this.proposals.getDocument(
      service.companyId,
      documentId,
    )) as {
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
      content: Buffer;
    };
    response.setHeader('Content-Type', document.mimeType);
    response.setHeader('Content-Length', String(document.sizeBytes));
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Content-SHA256', document.sha256);
    response.setHeader(
      'X-Lume-Filename',
      encodeURIComponent(document.fileName),
    );
    return new StreamableFile(document.content);
  }
}
