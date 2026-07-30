import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { CreateSupportRequestUseCase } from '../../application/use-cases/support/create-support-request.use-case';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import { CreateSupportRequestDto } from './dto/support.dto';

@ApiTags('Suporte')
@ApiBearerAuth()
@Controller('support/requests')
export class SupportController {
  constructor(private readonly createRequest: CreateSupportRequestUseCase) {}

  @Post()
  @RequireAnyPermission('support:create')
  @ApiCreatedResponse({
    description:
      'Solicitação entregue pelo provedor com identidade derivada da sessão autenticada.',
  })
  @ApiServiceUnavailableResponse({
    description:
      'Falha do provedor com código público, requestId e fallbackAllowed=true.',
  })
  create(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateSupportRequestDto,
  ) {
    return this.createRequest.execute({
      companyId: current.companyId,
      userId: current.id,
      requesterName: current.name,
      requesterUsername: current.username,
      requesterEmail: current.email,
      subject: body.subject,
      message: body.message,
    });
  }
}
