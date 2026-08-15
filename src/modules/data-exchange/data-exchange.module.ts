import { Module } from '@nestjs/common';

import { DataExchangeUseCase } from '../../application/use-cases/data-exchange/data-exchange.use-case';
import { DataExchangeConverter } from '../../infra/data-exchange/data-exchange-converter';
import { DataExchangeController } from './data-exchange.controller';

@Module({
  controllers: [DataExchangeController],
  providers: [DataExchangeConverter, DataExchangeUseCase],
  exports: [DataExchangeConverter],
})
export class DataExchangeModule {}
