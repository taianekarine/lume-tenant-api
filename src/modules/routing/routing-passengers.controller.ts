import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { PassengerImportUseCase } from '../../application/use-cases/routing/passenger-import.use-case';
import {
  PassengersUseCase,
  type PassengerMutationInput,
} from '../../application/use-cases/routing/passengers.use-case';
import { validationError } from '../../core/errors/app-error';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  ChangePassengerStatusDto,
  CreatePassengerDto,
  ImportPassengersDto,
  ListPassengersQueryDto,
  ResolvePassengerImportAddressDto,
  type PassengerAddressDto,
  type PassengerBoardingPointDto,
  UpdatePassengerDto,
} from './dto/passenger.dto';

interface UploadedPassengerWorkbook {
  originalname: string;
  size: number;
  buffer: Buffer;
}

function mapAddress(
  residence?: PassengerAddressDto | null,
): Partial<PassengerMutationInput> {
  if (!residence) return {};
  return {
    residenceStreet: residence.street,
    residenceNumber: residence.number,
    residenceComplement: residence.complement,
    residenceDistrict: residence.district,
    residencePostalCode: residence.postalCode,
    residenceCity: residence.city,
    residenceState: residence.state,
    residenceLatitude: residence.latitude,
    residenceLongitude: residence.longitude,
  };
}

function mapBoardingPoint(
  point?: PassengerBoardingPointDto | null,
): Partial<PassengerMutationInput> {
  if (point === undefined) return {};
  if (point === null) {
    return {
      predefinedBoardingLabel: null,
      predefinedBoardingStreet: null,
      predefinedBoardingNumber: null,
      predefinedBoardingComplement: null,
      predefinedBoardingDistrict: null,
      predefinedBoardingPostalCode: null,
      predefinedBoardingCity: null,
      predefinedBoardingState: null,
      predefinedBoardingLatitude: null,
      predefinedBoardingLongitude: null,
      predefinedBoardingOrigin: null,
      predefinedBoardingFixedPointId: null,
    };
  }
  return {
    predefinedBoardingLabel: point.label,
    predefinedBoardingStreet: point.street,
    predefinedBoardingNumber: point.number,
    predefinedBoardingComplement: point.complement,
    predefinedBoardingDistrict: point.district,
    predefinedBoardingPostalCode: point.postalCode,
    predefinedBoardingCity: point.city,
    predefinedBoardingState: point.state,
    predefinedBoardingLatitude: point.latitude,
    predefinedBoardingLongitude: point.longitude,
    predefinedBoardingOrigin: 'company',
    predefinedBoardingFixedPointId: null,
  };
}

@ApiTags('Roteirizacao - colaboradores')
@ApiBearerAuth()
@Controller('routing')
export class RoutingPassengersController {
  constructor(
    private readonly passengers: PassengersUseCase,
    private readonly imports: PassengerImportUseCase,
  ) {}

  @Post('passengers')
  @RequireAnyPermission('passengers:create')
  @ApiCreatedResponse({ description: 'Colaborador cadastrado.' })
  create(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreatePassengerDto,
  ) {
    const { residence, predefinedBoardingPoint, ...data } = body;
    return this.passengers.create(current, {
      ...data,
      ...mapAddress(residence),
      ...mapBoardingPoint(predefinedBoardingPoint),
    } as PassengerMutationInput & { commandId: string });
  }

  @Get('passengers')
  @RequireAnyPermission('passengers:view')
  list(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ListPassengersQueryDto,
  ) {
    return this.passengers.list(current, query);
  }

  @Get('passengers/template.xlsx')
  @RequireAnyPermission('passengers:import')
  @Header('Cache-Control', 'private, no-store')
  async template(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query('routingCompanyId') routingCompanyId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const content = await this.imports.template(current, routingCompanyId);
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="modelo-colaboradores.xlsx"',
    );
    response.setHeader('Content-Length', String(content.length));
    return new StreamableFile(content);
  }

  @Post('passengers/imports')
  @Throttle({ default: { limit: 4, ttl: 60_000 } })
  @RequireAnyPermission('passengers:import')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: 10 * 1024 * 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'commandId'],
      properties: {
        file: { type: 'string', format: 'binary' },
        commandId: { type: 'string', format: 'uuid' },
        routeId: { type: 'string', format: 'uuid' },
      },
    },
  })
  import(
    @CurrentUser() current: AuthenticatedPrincipal,
    @UploadedFile() file: UploadedPassengerWorkbook | undefined,
    @Body() body: ImportPassengersDto,
  ) {
    if (!file) throw validationError('Envie a planilha em file.');
    return this.imports.import(current, {
      ...body,
      fileName: file.originalname,
      content: file.buffer,
    });
  }

  @Get('passengers/imports/:batchId')
  @RequireAnyPermission('passengers:import', 'passengers:view')
  getImport(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('batchId', new ParseUUIDPipe({ version: '4' })) batchId: string,
  ) {
    return this.imports.get(current, batchId);
  }

  @Patch('passengers/imports/:batchId/records/:recordId/address')
  @RequireAnyPermission('passengers:import', 'passengers:update')
  resolveImportAddress(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('batchId', new ParseUUIDPipe({ version: '4' })) batchId: string,
    @Param('recordId', new ParseUUIDPipe({ version: '4' })) recordId: string,
    @Body() body: ResolvePassengerImportAddressDto,
  ) {
    return this.imports.resolveAddress(current, batchId, recordId, body);
  }

  @Get('passengers/:passengerId')
  @RequireAnyPermission('passengers:view')
  get(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('passengerId', new ParseUUIDPipe({ version: '4' }))
    passengerId: string,
  ) {
    return this.passengers.get(current, passengerId);
  }

  @Patch('passengers/:passengerId')
  @RequireAnyPermission('passengers:update')
  update(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('passengerId', new ParseUUIDPipe({ version: '4' }))
    passengerId: string,
    @Body() body: UpdatePassengerDto,
  ) {
    const { residence, predefinedBoardingPoint, ...data } = body;
    return this.passengers.update(current, passengerId, {
      ...data,
      ...mapAddress(residence),
      ...mapBoardingPoint(predefinedBoardingPoint),
    });
  }

  @Patch('passengers/:passengerId/status')
  @RequireAnyPermission('passengers:manage')
  status(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('passengerId', new ParseUUIDPipe({ version: '4' }))
    passengerId: string,
    @Body() body: ChangePassengerStatusDto,
  ) {
    return this.passengers.changeStatus(current, passengerId, body);
  }

  @Get('passengers/:passengerId/history')
  @RequireAnyPermission('passengers:view')
  history(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('passengerId', new ParseUUIDPipe({ version: '4' }))
    passengerId: string,
  ) {
    return this.passengers.history(current, passengerId);
  }
}
