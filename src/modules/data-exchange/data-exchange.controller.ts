import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
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
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { DataExchangeUseCase } from '../../application/use-cases/data-exchange/data-exchange.use-case';
import { validationError } from '../../core/errors/app-error';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  ConvertDataExchangeArtifactDto,
  UploadDataExchangeArtifactDto,
} from './dto/data-exchange.dto';

interface UploadedDataExchangeFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

function contentDisposition(fileName: string): string {
  const fallback =
    fileName
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/["\\\r\n]/g, '_')
      .slice(0, 180) || 'arquivo';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

@ApiTags('Importação e exportação de arquivos')
@ApiBearerAuth()
@Controller('data-exchange')
export class DataExchangeController {
  constructor(private readonly dataExchange: DataExchangeUseCase) {}

  @Get('capabilities')
  @RequireAnyPermission(
    'documents:view',
    'documents:create',
    'documents:manage',
  )
  @ApiOkResponse({
    description:
      'Matriz autoritativa de formatos e conversões que possuem adaptador ativo.',
  })
  capabilities() {
    return this.dataExchange.capabilities();
  }

  @Post('artifacts')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequireAnyPermission('documents:create', 'documents:manage')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: 25 * 1024 * 1024 },
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
        purpose: { type: 'string', maxLength: 120 },
      },
    },
  })
  @ApiCreatedResponse({
    description:
      'Arquivo temporário validado, identificado, hashado e armazenado no tenant.',
  })
  upload(
    @CurrentUser() current: AuthenticatedPrincipal,
    @UploadedFile() file: UploadedDataExchangeFile | undefined,
    @Body() body: UploadDataExchangeArtifactDto,
  ) {
    if (!file) throw validationError('Envie exatamente um arquivo em file.');
    return this.dataExchange.upload({
      companyId: current.companyId,
      actorUserId: current.id,
      commandId: body.commandId,
      purpose: body.purpose,
      originalName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      content: file.buffer,
    });
  }

  @Get('artifacts/:artifactId')
  @RequireAnyPermission('documents:view', 'documents:manage')
  detail(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('artifactId', new ParseUUIDPipe()) artifactId: string,
  ) {
    return this.dataExchange.get(current.companyId, artifactId);
  }

  @Post('artifacts/:artifactId/conversions')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @RequireAnyPermission('documents:manage')
  @ApiCreatedResponse({
    description:
      'Novo artefato convertido por um adaptador publicado na matriz de capacidades.',
  })
  convert(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('artifactId', new ParseUUIDPipe()) artifactId: string,
    @Body() body: ConvertDataExchangeArtifactDto,
  ) {
    return this.dataExchange.convert({
      companyId: current.companyId,
      actorUserId: current.id,
      artifactId,
      commandId: body.commandId,
      targetFormat: body.targetFormat,
      sheetName: body.sheetName?.trim() || null,
    });
  }

  @Get('artifacts/:artifactId/content')
  @RequireAnyPermission('documents:view', 'documents:manage')
  @Header('Cache-Control', 'private, no-store')
  async content(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('artifactId', new ParseUUIDPipe()) artifactId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const artifact = await this.dataExchange.getContent(
      current.companyId,
      artifactId,
    );
    response.setHeader('Content-Type', artifact.mimeType);
    response.setHeader('Content-Length', String(artifact.sizeBytes));
    response.setHeader(
      'Content-Disposition',
      contentDisposition(artifact.fileName),
    );
    response.setHeader('x-content-sha256', artifact.sha256);
    return new StreamableFile(artifact.content);
  }
}
