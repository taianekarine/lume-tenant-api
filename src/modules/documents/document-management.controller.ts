import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { DocumentManagementUseCase } from '../../application/use-cases/documents/document-management.use-case';
import { validationError } from '../../core/errors/app-error';
import type { DocumentFileSide } from '../../domain/documents/document-workflow';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  CreateChecklistDto,
  CreateDocumentRequestDto,
  CreateDocumentTypeDto,
  ExpiringDocumentsQueryDto,
  ListDocumentRequestsQueryDto,
  RenewDocumentDto,
  ReviewDocumentSubmissionDto,
  UpdateExtractedFieldsDto,
  UploadDocumentSubmissionDto,
} from './dto/document-management.dto';

interface UploadedDocumentFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

function contentDisposition(
  fileName: string,
  disposition: 'inline' | 'attachment',
): string {
  const fallback =
    fileName
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/["\\\r\n]/g, '_')
      .slice(0, 180) || 'documento';
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function parseFileMetadata(body: UploadDocumentSubmissionDto, count: number) {
  const sides = (body.sides ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const pages = (body.pageNumbers ?? '')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10));
  const allowed = new Set<DocumentFileSide>([
    'single',
    'front',
    'back',
    'page',
  ]);
  return Array.from({ length: count }, (_, index) => {
    const side = (sides[index] ??
      (count === 1 ? 'single' : 'page')) as DocumentFileSide;
    if (!allowed.has(side))
      throw validationError('Informe lados válidos para os arquivos.');
    const pageNumber = Number.isInteger(pages[index])
      ? pages[index]
      : index + 1;
    return { side, pageNumber };
  });
}

@ApiTags('Gestão documental')
@ApiBearerAuth()
@Controller('document-management')
export class DocumentManagementController {
  constructor(private readonly documents: DocumentManagementUseCase) {}

  @Get('document-types')
  @RequireAnyPermission('documents:manage')
  listDocumentTypes(@CurrentUser() current: AuthenticatedPrincipal) {
    return this.documents.listDocumentTypes(current);
  }

  @Post('document-types')
  @RequireAnyPermission('documents:manage')
  @ApiCreatedResponse({ description: 'Tipo documental configurável criado.' })
  createDocumentType(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateDocumentTypeDto,
  ) {
    return this.documents.createDocumentType(current, body);
  }

  @Get('checklists')
  @RequireAnyPermission('documents:manage')
  listChecklists(@CurrentUser() current: AuthenticatedPrincipal) {
    return this.documents.listChecklists(current);
  }

  @Post('checklists')
  @RequireAnyPermission('documents:manage')
  createChecklist(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateChecklistDto,
  ) {
    return this.documents.createChecklist(current, body);
  }

  @Post('requests')
  @RequireAnyPermission('documents:manage')
  createRequest(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateDocumentRequestDto,
  ) {
    return this.documents.createRequest(current, body);
  }

  @Get('requests')
  @RequireAnyPermission('documents:view', 'documents:manage')
  listRequests(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ListDocumentRequestsQueryDto,
  ) {
    return this.documents.listRequests(current, query);
  }

  @Get('requests/:requestId')
  @RequireAnyPermission('documents:view', 'documents:manage')
  getRequest(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string,
  ) {
    return this.documents.getRequest(current, requestId);
  }

  @Get('requests/:requestId/history')
  @RequireAnyPermission('documents:view', 'documents:manage')
  history(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string,
  ) {
    return this.documents.history(current, requestId);
  }

  @Post('items/:requestItemId/submissions')
  @RequireAnyPermission(
    'documents:create',
    'documents:update',
    'documents:manage',
  )
  @UseInterceptors(
    FilesInterceptor('files', 24, {
      limits: { files: 24, fileSize: 25 * 1024 * 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['commandId', 'files'],
      properties: {
        commandId: { type: 'string', format: 'uuid' },
        files: { type: 'array', items: { type: 'string', format: 'binary' } },
        sides: { type: 'string', example: 'front,back' },
        pageNumbers: { type: 'string', example: '1,1' },
      },
    },
  })
  upload(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('requestItemId', new ParseUUIDPipe({ version: '4' }))
    requestItemId: string,
    @UploadedFiles() files: UploadedDocumentFile[] | undefined,
    @Body() body: UploadDocumentSubmissionDto,
  ) {
    if (!files?.length) throw validationError('Envie ao menos um arquivo.');
    const metadata = parseFileMetadata(body, files.length);
    return this.documents.upload(current, requestItemId, {
      commandId: body.commandId,
      files: files.map((file, index) => ({
        originalName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        content: file.buffer,
        side: metadata[index].side,
        pageNumber: metadata[index].pageNumber,
      })),
    });
  }

  @Post('submissions/:submissionId/complete')
  @RequireAnyPermission(
    'documents:create',
    'documents:update',
    'documents:manage',
  )
  completeSubmission(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('submissionId', new ParseUUIDPipe({ version: '4' }))
    submissionId: string,
  ) {
    return this.documents.completeSubmission(current, submissionId);
  }

  @Post('submissions/:submissionId/extracted-data')
  @RequireAnyPermission('documents:approve')
  updateExtractedData(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('submissionId', new ParseUUIDPipe({ version: '4' }))
    submissionId: string,
    @Body() body: UpdateExtractedFieldsDto,
  ) {
    return this.documents.updateExtractedData(current, submissionId, body);
  }

  @Post('submissions/:submissionId/reviews')
  @RequireAnyPermission('documents:approve')
  review(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('submissionId', new ParseUUIDPipe({ version: '4' }))
    submissionId: string,
    @Body() body: ReviewDocumentSubmissionDto,
  ) {
    return this.documents.review(current, submissionId, body);
  }

  @Get('files/:fileId/content')
  @RequireAnyPermission('documents:view', 'documents:manage')
  @Header('Cache-Control', 'private, no-store')
  async fileContent(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('fileId', new ParseUUIDPipe({ version: '4' })) fileId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.documents.fileContent(current, fileId);
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(file.sizeBytes));
    response.setHeader(
      'Content-Disposition',
      contentDisposition(file.fileName, 'inline'),
    );
    response.setHeader('x-content-sha256', file.sha256);
    return new StreamableFile(file.content);
  }

  @Get('expiring')
  @RequireAnyPermission('documents:view', 'documents:manage')
  expiring(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ExpiringDocumentsQueryDto,
  ) {
    return this.documents.expiring(current, query.withinDays);
  }

  @Post('items/:requestItemId/renewal')
  @RequireAnyPermission('documents:manage')
  renew(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('requestItemId', new ParseUUIDPipe({ version: '4' }))
    requestItemId: string,
    @Body() body: RenewDocumentDto,
  ) {
    return this.documents.renew(current, requestItemId, body);
  }

  @Get('export.xlsx')
  @RequireAnyPermission('documents:export')
  @Header('Cache-Control', 'private, no-store')
  async exportXlsx(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.documents.exportXlsx(current);
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      contentDisposition('gestao-documental.xlsx', 'attachment'),
    );
    return new StreamableFile(file);
  }

  @Get('users/:subjectUserId/export.xlsx')
  @RequireAnyPermission('documents:export')
  @Header('Cache-Control', 'private, no-store')
  async exportUserXlsx(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('subjectUserId', new ParseUUIDPipe({ version: '4' }))
    subjectUserId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.documents.exportXlsx(current, subjectUserId);
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      contentDisposition(
        `dados-documentais-${subjectUserId}.xlsx`,
        'attachment',
      ),
    );
    return new StreamableFile(file);
  }

  @Get('users/:subjectUserId/files.zip')
  @RequireAnyPermission('documents:export')
  @Header('Cache-Control', 'private, no-store')
  async exportUserFiles(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('subjectUserId', new ParseUUIDPipe({ version: '4' }))
    subjectUserId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.documents.exportUserFiles(current, subjectUserId);
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader(
      'Content-Disposition',
      contentDisposition(
        `arquivos-documentais-${subjectUserId}.zip`,
        'attachment',
      ),
    );
    return new StreamableFile(file);
  }
}
