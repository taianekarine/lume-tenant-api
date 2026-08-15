import { Module } from '@nestjs/common';

import { RoutingRepository } from '../../application/contracts/routing.repository';
import { RoutingCompaniesUseCase } from '../../application/use-cases/routing/routing-companies.use-case';
import { RoutingController } from './routing.controller';
import { PassengerRepository } from '../../application/contracts/passenger.repository';
import { PassengersUseCase } from '../../application/use-cases/routing/passengers.use-case';
import { PassengerImportUseCase } from '../../application/use-cases/routing/passenger-import.use-case';
import { PassengerWorkbookService } from '../../infra/routing/passenger-workbook.service';
import { RoutingPassengersController } from './routing-passengers.controller';
import { ContractRepository } from '../../application/contracts/contract.repository';
import { RoutingContractsUseCase } from '../../application/use-cases/routing/routing-contracts.use-case';
import { RoutingContractsController } from './routing-contracts.controller';
import { RouteRepository } from '../../application/contracts/route.repository';
import { RoutesUseCase } from '../../application/use-cases/routing/routes.use-case';
import { RoutingAgentService } from '../../infra/routing/routing-agent.service';
import { RoutingRoutesController } from './routing-routes.controller';
import { RouteExportService } from '../../infra/routing/route-export.service';

@Module({
  controllers: [
    RoutingController,
    RoutingContractsController,
    RoutingPassengersController,
    RoutingRoutesController,
  ],
  providers: [
    {
      provide: RoutingCompaniesUseCase,
      useFactory: (routing: RoutingRepository) =>
        new RoutingCompaniesUseCase(routing),
      inject: [RoutingRepository],
    },
    {
      provide: RoutingContractsUseCase,
      useFactory: (contracts: ContractRepository, routing: RoutingRepository) =>
        new RoutingContractsUseCase(contracts, routing),
      inject: [ContractRepository, RoutingRepository],
    },
    {
      provide: RoutesUseCase,
      useFactory: (
        routes: RouteRepository,
        contracts: ContractRepository,
        passengers: PassengerRepository,
        agent: RoutingAgentService,
        companies: RoutingRepository,
      ) => new RoutesUseCase(routes, contracts, passengers, agent, companies),
      inject: [
        RouteRepository,
        ContractRepository,
        PassengerRepository,
        RoutingAgentService,
        RoutingRepository,
      ],
    },
    RoutingAgentService,
    RouteExportService,
    {
      provide: PassengersUseCase,
      useFactory: (
        passengers: PassengerRepository,
        routing: RoutingRepository,
      ) => new PassengersUseCase(passengers, routing),
      inject: [PassengerRepository, RoutingRepository],
    },
    PassengerWorkbookService,
    {
      provide: PassengerImportUseCase,
      useFactory: (
        passengers: PassengerRepository,
        routing: RoutingRepository,
        workbook: PassengerWorkbookService,
      ) => new PassengerImportUseCase(passengers, routing, workbook),
      inject: [
        PassengerRepository,
        RoutingRepository,
        PassengerWorkbookService,
      ],
    },
  ],
  exports: [
    RoutingCompaniesUseCase,
    RoutingContractsUseCase,
    RoutesUseCase,
    PassengersUseCase,
    PassengerImportUseCase,
  ],
})
export class RoutingModule {}
