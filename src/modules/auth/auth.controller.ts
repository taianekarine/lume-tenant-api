import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { AuthenticateUseCase } from '../../application/use-cases/auth/authenticate.use-case';
import { LogoutUseCase } from '../../application/use-cases/auth/logout.use-case';
import { RefreshSessionUseCase } from '../../application/use-cases/auth/refresh-session.use-case';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { Public } from '../../shared/http/decorators/public.decorator';
import { LoginDto, RefreshTokenDto } from './dto/auth.dto';

@ApiTags('Autenticação')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authenticate: AuthenticateUseCase,
    private readonly refreshSession: RefreshSessionUseCase,
    private readonly logout: LogoutUseCase,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Sessão autenticada e par de tokens.' })
  @ApiUnauthorizedResponse({ description: 'Credenciais inválidas.' })
  login(@Body() body: LoginDto) {
    return this.authenticate.execute(body);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    description: 'Tokens renovados com rotação do refresh token.',
  })
  @ApiUnauthorizedResponse({ description: 'Sessão inválida ou expirada.' })
  refresh(@Body() body: RefreshTokenDto) {
    return this.refreshSession.execute(body.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Sessão revogada quando existente.' })
  async signOut(@Body() body: RefreshTokenDto): Promise<void> {
    await this.logout.execute(body.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Empresa e usuário autenticado atual.' })
  me(@CurrentUser() principal: AuthenticatedPrincipal) {
    const { companyId, tokenVersion, ...user } = principal;
    void tokenVersion;
    return { companyId, user };
  }
}
