import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FileInterceptor,
} from '@nestjs/platform-express';
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
import { validationError } from '../../core/errors/app-error';
import { WhatsAppHistoryImportService } from '../../infra/imports/whatsapp-history-import.service';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  AddWhatsAppAndroidBackupDto,
  ApplyWhatsAppHistoryImportDto,
  CreateWhatsAppHistoryImportDto,
  UpdateWhatsAppHistoryMappingDto,
} from './dto/whatsapp-history-import.dto';

interface UploadedWhatsAppHistoryArchive {
  originalname: string;
  size: number;
  buffer: Buffer;
}

interface UploadedWhatsAppAndroidDatabase {
  originalname: string;
  size: number;
  path: string;
}

function contentDisposition(fileName: string): string {
  const fallback =
    fileName
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/["\\\r\n]/g, '_')
      .slice(0, 180) || 'historico-whatsapp.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

@ApiTags('Importação de históricos do WhatsApp')
@ApiBearerAuth()
@RequireAnyPermission('whatsapp-conversations:manage')
@Controller('whatsapp/history-imports')
export class WhatsAppHistoryImportController {
  constructor(private readonly imports: WhatsAppHistoryImportService) {}

  @Get('channels')
  @ApiOkResponse({ description: 'Canais disponíveis para a importação.' })
  channels(@CurrentUser() current: AuthenticatedPrincipal) {
    return this.imports.channels(current.companyId);
  }

  @Post()
  @ApiCreatedResponse({ description: 'Lote de importação criado.' })
  create(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateWhatsAppHistoryImportDto,
  ) {
    return this.imports.create({
      companyId: current.companyId,
      actorUserId: current.id,
      actorUsername: current.username,
      commandId: body.commandId,
      channelId: body.channelId,
    });
  }

  @Get(':batchId')
  detail(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
  ) {
    return this.imports.detail(current.companyId, batchId);
  }

  @Post(':batchId/archives')
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('archive', {
      limits: { files: 1, fileSize: 512 * 1024 * 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['archive'],
      properties: {
        archive: { type: 'string', format: 'binary' },
      },
    },
  })
  addArchive(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @UploadedFile() file: UploadedWhatsAppHistoryArchive | undefined,
  ) {
    if (!file) throw validationError('Selecione um backup ZIP do WhatsApp.');
    return this.imports.addArchive(current.companyId, batchId, {
      originalName: file.originalname,
      sizeBytes: file.size,
      content: file.buffer,
    });
  }

  @Post(':batchId/android-backup')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @UseInterceptors(
    FileFieldsInterceptor([{ name: 'database', maxCount: 1 }], {
      limits: { files: 1, fileSize: 2_147_483_647 },
      dest:
        process.env.WHATSAPP_IMPORT_UPLOAD_TEMP_ROOT ??
        'var/imports/whatsapp/incoming',
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['database', 'rootKey', 'state', 'departmentCode'],
      properties: {
        database: { type: 'string', format: 'binary' },
        rootKey: { type: 'string', format: 'password', minLength: 64 },
        state: {
          type: 'string',
          enum: ['human-queue', 'human-active', 'closed', 'bot-menu'],
        },
        departmentCode: { type: 'string' },
        ownerUsername: { type: 'string', nullable: true },
      },
    },
  })
  addAndroidBackup(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @UploadedFiles()
    files: { database?: UploadedWhatsAppAndroidDatabase[] } | undefined,
    @Body() body: AddWhatsAppAndroidBackupDto,
  ) {
    const database = files?.database?.[0];
    if (!database) {
      throw validationError('Selecione o arquivo msgstore.db.crypt15.');
    }
    return this.imports.addAndroidBackup(current.companyId, batchId, {
      originalName: database.originalname,
      sizeBytes: database.size,
      temporaryPath: database.path,
      rootKeyHex: body.rootKey,
      state: body.state,
      departmentCode: body.departmentCode,
      ownerUsername: body.ownerUsername,
    });
  }

  @Patch(':batchId/archives/:archiveId')
  updateMapping(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @Param('archiveId') archiveId: string,
    @Body() body: UpdateWhatsAppHistoryMappingDto,
  ) {
    return this.imports.updateMapping(
      current.companyId,
      batchId,
      archiveId,
      body,
    );
  }

  @Get(':batchId/workbook')
  @Header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  async workbook(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const workbook = await this.imports.workbook(current.companyId, batchId);
    response.setHeader(
      'Content-Disposition',
      contentDisposition(workbook.fileName),
    );
    response.setHeader(
      'Content-Length',
      workbook.content.byteLength.toString(),
    );
    return new StreamableFile(workbook.content);
  }

  @Post(':batchId/apply')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  apply(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @Body() body: ApplyWhatsAppHistoryImportDto,
  ) {
    return this.imports.apply(
      current.companyId,
      batchId,
      new Date(body.cutoffAt),
    );
  }
}
