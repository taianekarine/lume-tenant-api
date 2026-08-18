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
  AddWhatsAppAndroidMediaChunkDto,
  ApplyWhatsAppHistoryImportDto,
  CreateWhatsAppAndroidMediaUploadDto,
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

interface UploadedWhatsAppAndroidMediaArchive {
  originalname: string;
  size: number;
  path: string;
}

interface UploadedWhatsAppAndroidMediaChunk {
  size: number;
  buffer: Buffer;
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

  @Get('android-backups')
  @ApiOkResponse({
    description: 'Backups Android concluídos disponíveis para vincular mídias.',
  })
  appliedAndroidBackups(@CurrentUser() current: AuthenticatedPrincipal) {
    return this.imports.appliedAndroidBackups(current.companyId);
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

  @Post(':batchId/android-media-archives')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('archive', {
      limits: { files: 1, fileSize: 512 * 1024 * 1024 },
      dest:
        process.env.WHATSAPP_IMPORT_UPLOAD_TEMP_ROOT ??
        'var/imports/whatsapp/incoming',
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
  addAndroidMediaArchive(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @UploadedFile()
    file: UploadedWhatsAppAndroidMediaArchive | undefined,
  ) {
    if (!file) {
      throw validationError('Selecione um arquivo ZIP da pasta Media.');
    }
    return this.imports.addAndroidMediaArchive(current.companyId, batchId, {
      originalName: file.originalname,
      sizeBytes: file.size,
      temporaryPath: file.path,
    });
  }

  @Post(':batchId/android-media-uploads')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiCreatedResponse({ description: 'Envio fracionado de mídias iniciado.' })
  createAndroidMediaUpload(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @Body() body: CreateWhatsAppAndroidMediaUploadDto,
  ) {
    return this.imports.createAndroidMediaUpload(current.companyId, batchId, {
      originalName: body.fileName,
      sizeBytes: body.sizeBytes,
    });
  }

  @Post(':batchId/android-media-uploads/:uploadId/chunks')
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('chunk', {
      limits: { files: 1, fileSize: 32 * 1024 * 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['chunk', 'offsetBytes'],
      properties: {
        chunk: { type: 'string', format: 'binary' },
        offsetBytes: { type: 'integer', minimum: 0 },
      },
    },
  })
  addAndroidMediaUploadChunk(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
    @UploadedFile() file: UploadedWhatsAppAndroidMediaChunk | undefined,
    @Body() body: AddWhatsAppAndroidMediaChunkDto,
  ) {
    if (!file?.buffer?.byteLength) {
      throw validationError('O bloco do ZIP de mídias está vazio.');
    }
    return this.imports.addAndroidMediaUploadChunk(current.companyId, batchId, {
      uploadId,
      offsetBytes: body.offsetBytes,
      content: file.buffer,
    });
  }

  @Post(':batchId/android-media-uploads/:uploadId/complete')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOkResponse({ description: 'Processamento do ZIP iniciado.' })
  completeAndroidMediaUpload(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
  ) {
    return this.imports.completeAndroidMediaUpload(
      current.companyId,
      batchId,
      uploadId,
    );
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
