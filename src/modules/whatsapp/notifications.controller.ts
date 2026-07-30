import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { QuoteProposalUseCase } from '../../application/use-cases/whatsapp/whatsapp.use-cases';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';

@ApiTags('Notificações')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly quoteProposals: QuoteProposalUseCase) {}

  @Get()
  @ApiOkResponse({
    description:
      'Pendências resumidas e limitadas aos departamentos do usuário autenticado.',
  })
  async list(@CurrentUser() current: AuthenticatedPrincipal) {
    if (!current.departments.includes('commercial')) {
      return { items: [], total: 0, unreadTotal: 0 };
    }

    const { pendingTotal, unreadTotal } =
      await this.quoteProposals.notificationSummary(
        current.companyId,
        current.id,
      );

    return {
      items:
        pendingTotal === 0
          ? []
          : [
              {
                id: 'commercial.pending-quote-proposals',
                type: 'quote-proposal-pending',
                department: 'commercial',
                title:
                  pendingTotal === 1
                    ? '1 orçamento pendente'
                    : `${pendingTotal} orçamentos pendentes`,
                description:
                  'A fila Comercial possui orçamentos aguardando envio.',
                href: '/quote-proposals',
                count: pendingTotal,
                unreadCount: unreadTotal,
                read: unreadTotal === 0,
              },
            ],
      total: pendingTotal,
      unreadTotal,
    };
  }

  @Post('commercial.pending-quote-proposals/read')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    description:
      'Marca como visualizados todos os orçamentos atualmente pendentes para o usuário autenticado.',
  })
  markCommercialQuotesRead(@CurrentUser() current: AuthenticatedPrincipal) {
    if (!current.departments.includes('commercial')) {
      return {
        notificationId: 'commercial.pending-quote-proposals' as const,
        pendingTotal: 0,
        unreadTotal: 0,
        markedRead: 0,
        readAt: new Date().toISOString(),
      };
    }
    return this.quoteProposals.markNotificationRead(
      current.companyId,
      current.id,
    );
  }
}
