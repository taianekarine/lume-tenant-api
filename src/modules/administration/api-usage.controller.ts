import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import { ApiUsageService } from './api-usage.service';
import {
  ApiUsagePeriodQueryDto,
  ListApiUsageQueryDto,
} from './dto/api-usage.dto';

@ApiTags('Administração da plataforma')
@ApiBearerAuth()
@Controller('administration/usage')
export class ApiUsageController {
  constructor(private readonly usage: ApiUsageService) {}

  @Get('summary')
  @RequireAnyPermission('settings:view')
  summary(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ApiUsagePeriodQueryDto,
  ) {
    return this.usage.summary(current, query);
  }

  @Get('requests')
  @RequireAnyPermission('settings:view')
  list(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ListApiUsageQueryDto,
  ) {
    return this.usage.list(current, query);
  }
}
