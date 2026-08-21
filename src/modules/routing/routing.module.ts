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
import { FixedPointRepository } from '../../application/contracts/fixed-point.repository';
import { FixedPointsUseCase } from '../../application/use-cases/routing/fixed-points.use-case';
import { RoutingFixedPointsController } from './routing-fixed-points.controller';
import { PasswordHasher } from '../../application/contracts/cryptography';
import { UsersRepository } from '../../application/contracts/repositories';
import { DataExchangeModule } from '../data-exchange/data-exchange.module';
import { PostalCodeLookupService } from '../../infra/routing/postal-code-lookup.service';

@Module({
  imports: [DataExchangeModule],
  controllers: [
    RoutingController,
    RoutingContractsController,
    RoutingPassengersController,
    RoutingRoutesController,
    RoutingFixedPointsController,
  ],
  providers: [
    {
      provide: RoutingCompaniesUseCase,
      useFactory: (
        routing: RoutingRepository,
        users: UsersRepository,
        passwordHasher: PasswordHasher,
      ) => new RoutingCompaniesUseCase(routing, users, passwordHasher),
      inject: [RoutingRepository, UsersRepository, PasswordHasher],
    },
    {
      provide: RoutingContractsUseCase,
      useFactory: (
        contracts: ContractRepository,
        routing: RoutingRepository,
        points: FixedPointRepository,
      ) => new RoutingContractsUseCase(contracts, routing, points),
      inject: [ContractRepository, RoutingRepository, FixedPointRepository],
    },
    {
      provide: FixedPointsUseCase,
      useFactory: (points: FixedPointRepository, routing: RoutingRepository) =>
        new FixedPointsUseCase(points, routing),
      inject: [FixedPointRepository, RoutingRepository],
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
    PostalCodeLookupService,
    {
      provide: PassengerImportUseCase,
      useFactory: (
        passengers: PassengerRepository,
        routing: RoutingRepository,
        workbook: PassengerWorkbookService,
        points: FixedPointRepository,
        postalCodes: PostalCodeLookupService,
      ) =>
        new PassengerImportUseCase(
          passengers,
          routing,
          workbook,
          points,
          postalCodes,
        ),
      inject: [
        PassengerRepository,
        RoutingRepository,
        PassengerWorkbookService,
        FixedPointRepository,
        PostalCodeLookupService,
      ],
    },
  ],
  exports: [
    RoutingCompaniesUseCase,
    RoutingContractsUseCase,
    RoutesUseCase,
    PassengersUseCase,
    PassengerImportUseCase,
    FixedPointsUseCase,
  ],
})
export class RoutingModule {}
