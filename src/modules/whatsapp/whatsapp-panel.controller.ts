import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import {
  CreateHumanOutboundWhatsAppUseCase,
  QueryWhatsAppUseCase,
  TransitionWhatsAppConversationUseCase,
} from '../../application/use-cases/whatsapp/whatsapp.use-cases';
import { forbidden, validationError } from '../../core/errors/app-error';
import { normalizeUserDepartment } from '../../domain/access/access.constants';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  CloseConversationDto,
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

  @Get('dashboard')
  @RequireAnyPermission('dashboard:view')
  @ApiOkResponse({
    description:
      'Indicadores operacionais limitados aos departamentos atribuídos ao usuário autenticado.',
  })
  dashboard(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ConversationListQueryDto,
  ) {
    const assignedDepartments = current.departments.map(
      normalizeUserDepartment,
    );
    const canManageAll = current.permissions.includes(
      'whatsapp-conversations:manage',
    );

    if (assignedDepartments.length === 0) {
      if (!canManageAll) {
        throw forbidden(
          'Seu perfil não possui departamento atribuído para consultar os indicadores operacionais.',
        );
      }

      return this.queryUseCase.listConversations(current.companyId, query);
    }

    if (query.department) {
      if (!assignedDepartments.includes(query.department)) {
        throw forbidden(
          'O departamento solicitado não está atribuído ao seu perfil.',
        );
      }

      return this.queryUseCase.listConversations(current.companyId, query);
    }

    if (assignedDepartments.length > 1) {
      throw validationError(
        'Informe um dos departamentos atribuídos ao seu perfil.',
      );
    }

    return this.queryUseCase.listConversations(current.companyId, {
      ...query,
      department: assignedDepartments[0],
    });
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

  @Post(':conversationId/actions/close')
  @RequireAnyPermission('whatsapp-conversations:manage')
  @ApiCreatedResponse({
    description:
      'Encerra uma conversa sem proposta ativa e registra motivo, ator e data na transição e na auditoria.',
  })
  close(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() body: CloseConversationDto,
  ) {
    return this.panelTransition(current, conversationId, body, 'close', {
      metadata: { reason: body.reason ?? null },
    });
  }

  @Post(':conversationId/actions/close-after-rejection')
  @RequireAnyPermission('whatsapp-conversations:manage')
  @ApiOperation({
    deprecated: true,
    summary: 'Alias compatível da ação canônica de encerramento',
  })
  @ApiCreatedResponse({
    description:
      'Alias legado da ação canônica de encerramento; aplica as mesmas regras e produz a transição close.',
  })
  closeAfterRejection(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() body: CloseConversationDto,
  ) {
    return this.panelTransition(current, conversationId, body, 'close', {
      metadata: { reason: body.reason ?? null },
    });
  }

  private panelTransition(
    current: AuthenticatedPrincipal,
    conversationId: string,
    body: VersionedCommandDto,
    name: 'take-over' | 'return-to-bot' | 'forward' | 'mark-read' | 'close',
    extra: {
      targetDepartment?: ForwardConversationDto['targetDepartment'];
      metadata?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    return this.transition.execute({
      companyId: current.companyId,
      conversationId,
      commandId: body.commandId,
      expectedVersion: body.expectedVersion,
      name,
      actorType: 'user',
      actorUserId: current.id,
      ...extra,
    });
  }
}
