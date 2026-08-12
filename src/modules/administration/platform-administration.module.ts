import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { ApiUsageController } from './api-usage.controller';
import { ApiUsageInterceptor } from './api-usage.interceptor';
import { ApiUsageRecorderService } from './api-usage-recorder.service';
import { ApiUsageService } from './api-usage.service';

@Module({
  controllers: [ApiUsageController],
  providers: [
    ApiUsageRecorderService,
    ApiUsageService,
    { provide: APP_INTERCEPTOR, useClass: ApiUsageInterceptor },
  ],
})
export class PlatformAdministrationModule {}
