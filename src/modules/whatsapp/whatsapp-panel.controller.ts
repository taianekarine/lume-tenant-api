import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import {
  CreateHumanOutboundWhatsAppUseCase,
  QueryWhatsAppUseCase,
  TransitionWhatsAppConversationUseCase,
} from '../../application/use-cases/whatsapp/whatsapp.use-cases';
import { forbidden, validationError } from '../../core/errors/app-error';
import { normalizeUserDepartment } from '../../domain/access/access.constants';
import { EvolutionMediaContentService } from '../../infra/integrations/evolution/evolution-media-content.service';
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

function contentDisposition(fileName: string): string {
  const fallback =
    fileName
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/["\\\r\n]/g, '_')
      .slice(0, 180) || 'midia-whatsapp';
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

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
    private readonly mediaContent: EvolutionMediaContentService,
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

  @Get(':conversationId/messages/:messageId/content')
  @Header('Cache-Control', 'private, no-store')
  @ApiOkResponse({
    description: 'Conteúdo da mídia disponível para visualização segura.',
  })
  async messageContent(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const media = await this.mediaContent.getContent(
      current.companyId,
      conversationId,
      messageId,
    );
    response.setHeader('Content-Type', media.mimeType);
    response.setHeader('Content-Length', String(media.content.byteLength));
    response.setHeader(
      'Content-Disposition',
      contentDisposition(media.fileName),
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'X-WhatsApp-Media-Filename',
      encodeURIComponent(media.fileName),
    );
    response.setHeader('X-WhatsApp-Media-Kind', media.kind);
    return new StreamableFile(media.content);
  }

  @Post(':conversationId/messages/:messageId/content/retain')
  @RequireAnyPermission('whatsapp-conversations:manage')
  @ApiOkResponse({
    description:
      'Armazena de forma idempotente uma mídia histórica que ainda esteja disponível.',
  })
  async retainMessageContent(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
  ) {
    const result = await this.mediaContent.retainInbound(
      current.companyId,
      conversationId,
      messageId,
    );
    return {
      available: ['stored', 'already-stored'].includes(result.status),
      message:
        result.status === 'unavailable'
          ? 'Este arquivo antigo não está mais disponível.'
          : result.status === 'too-large'
            ? 'Este arquivo excede o limite permitido para armazenamento.'
            : 'Arquivo armazenado com segurança.',
      ...(result.sizeBytes ? { sizeBytes: result.sizeBytes } : {}),
      ...(result.mimeType ? { mimeType: result.mimeType } : {}),
    };
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
