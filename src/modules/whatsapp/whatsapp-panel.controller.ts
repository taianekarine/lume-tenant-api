import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import {
  CreateHumanOutboundWhatsAppUseCase,
  QueryWhatsAppUseCase,
  TransitionWhatsAppConversationUseCase,
} from '../../application/use-cases/whatsapp/whatsapp.use-cases';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  ConversationListQueryDto,
  CreateHumanOutboundMessageDto,
  ForwardConversationDto,
  MessageListQueryDto,
  TransitionListQueryDto,
  VersionedCommandDto,
} from './dto/whatsapp.dto';

@ApiTags('Painel WhatsApp')
@ApiBearerAuth()
@RequireAnyPermission(
  'whatsapp-conversations:view',
  'whatsapp-conversations:manage',
)
@Controller('whatsapp/conversations')
export class WhatsAppPanelController {
  constructor(
    private readonly queryUseCase: QueryWhatsAppUseCase,
    private readonly transition: TransitionWhatsAppConversationUseCase,
    private readonly createHumanOutbound: CreateHumanOutboundWhatsAppUseCase,
  ) {}

  @Get()
  list(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ConversationListQueryDto,
  ) {
    return this.queryUseCase.listConversations(current.companyId, query);
  }

  @Get(':conversationId')
  detail(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
  ) {
    return this.queryUseCase.getConversation(current.companyId, conversationId);
  }

  @Get(':conversationId/messages')
  messages(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Query() query: MessageListQueryDto,
  ) {
    return this.queryUseCase.listMessages(
      current.companyId,
      conversationId,
      query,
    );
  }

  @Get(':conversationId/transitions')
  transitions(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Query() query: TransitionListQueryDto,
  ) {
    return this.queryUseCase.listTransitions(
      current.companyId,
      conversationId,
      query,
    );
  }

  @Post(':conversationId/messages')
  @RequireAnyPermission('whatsapp-conversations:manage')
  createMessage(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() body: CreateHumanOutboundMessageDto,
  ) {
    return this.createHumanOutbound.execute({
      ...body,
      companyId: current.companyId,
      conversationId,
      actorUserId: current.id,
    });
  }

  @Get(':conversationId/quote-request')
  quote(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
  ) {
    return this.queryUseCase.getCurrentQuoteRequest(
      current.companyId,
      conversationId,
    );
  }

  @Post(':conversationId/actions/take-over')
  @RequireAnyPermission('whatsapp-conversations:manage')
  takeOver(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() body: VersionedCommandDto,
  ) {
    return this.panelTransition(current, conversationId, body, 'take-over');
  }

  @Post(':conversationId/actions/return-to-bot')
  @RequireAnyPermission('whatsapp-conversations:manage')
  returnToBot(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() body: VersionedCommandDto,
  ) {
    return this.panelTransition(current, conversationId, body, 'return-to-bot');
  }

  @Post(':conversationId/actions/forward')
  @RequireAnyPermission('whatsapp-conversations:manage')
  forward(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() body: ForwardConversationDto,
  ) {
    return this.panelTransition(current, conversationId, body, 'forward', {
      targetDepartment: body.targetDepartment,
    });
  }

  @Post(':conversationId/actions/mark-read')
  @RequireAnyPermission('whatsapp-conversations:manage')
  @ApiOkResponse({ description: 'Contador zerado com concorrência otimista.' })
  markRead(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() body: VersionedCommandDto,
  ) {
    return this.panelTransition(current, conversationId, body, 'mark-read');
  }

  private panelTransition(
    current: AuthenticatedPrincipal,
    conversationId: string,
    body: VersionedCommandDto,
    name: 'take-over' | 'return-to-bot' | 'forward' | 'mark-read',
    extra: {
      targetDepartment?: ForwardConversationDto['targetDepartment'];
    } = {},
  ) {
    return this.transition.execute({
      ...body,
      ...extra,
      companyId: current.companyId,
      conversationId,
      name,
      actorType: 'user',
      actorUserId: current.id,
    });
  }
}
