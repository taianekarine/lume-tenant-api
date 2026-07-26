import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import {
  ClaimEvolutionDispatchUseCase,
  CompleteOutboxExecutionUseCase,
  CreateOutboundWhatsAppUseCase,
  PatchQuoteRequestUseCase,
  QueryWhatsAppUseCase,
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
  ClaimEvolutionDispatchDto,
  CompleteOutboxExecutionDto,
  CreateOutboundMessageDto,
  EvolutionResultDto,
  PatchQuoteRequestDto,
  TransitionConversationDto,
} from './dto/whatsapp.dto';

@ApiTags('WhatsApp interno n8n')
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
    private readonly query: QueryWhatsAppUseCase,
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
      actorType: 'n8n',
    });
  }

  @Patch('quote-requests/:quoteRequestId')
  patchQuoteRequest(
    @CurrentService() service: ServicePrincipal,
    @Param('quoteRequestId', new ParseUUIDPipe()) quoteRequestId: string,
    @Body() body: PatchQuoteRequestDto,
  ) {
    return this.patchQuote.execute(service.companyId, quoteRequestId, {
      ...body,
      departureAt:
        body.departureAt === undefined
          ? undefined
          : body.departureAt === null
            ? null
            : new Date(body.departureAt),
      returnAt:
        body.returnAt === undefined
          ? undefined
          : body.returnAt === null
            ? null
            : new Date(body.returnAt),
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
}
