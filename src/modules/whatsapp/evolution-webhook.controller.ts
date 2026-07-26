import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { EvolutionWebhookService } from '../../infra/integrations/evolution/evolution-webhook.service';
import { Public } from '../../shared/http/decorators/public.decorator';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@ApiTags('Webhooks')
@Controller('webhooks/evolution')
export class EvolutionWebhookController {
  constructor(private readonly webhook: EvolutionWebhookService) {}

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post(':channelId')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({
    name: 'x-evolution-timestamp',
    required: false,
    description: 'Obrigatório apenas no modo HMAC/proxy assinador.',
  })
  @ApiHeader({ name: 'x-evolution-signature', required: false })
  @ApiHeader({
    name: 'x-evolution-webhook-token',
    required: false,
    description:
      'Token estático recomendado para o header configurável da Evolution.',
  })
  @ApiAcceptedResponse({
    description:
      'Inbound persistido de forma idempotente e publicado na outbox.',
  })
  handle(
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() request: RawBodyRequest,
    @Body() body: unknown,
  ) {
    if (!request.rawBody) {
      throw new Error('Raw body do webhook não está disponível.');
    }
    return this.webhook.handle({
      channelId,
      headers,
      rawBody: request.rawBody,
      body,
    });
  }
}
