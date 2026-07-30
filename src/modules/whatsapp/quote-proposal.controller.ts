import {
  Controller,
  Body,
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
import { QuoteProposalUseCase } from '../../application/use-cases/whatsapp/whatsapp.use-cases';
import { forbidden, notFound } from '../../core/errors/app-error';
import { QUOTE_PROPOSAL_MAX_PDF_BYTES } from '../../domain/whatsapp/whatsapp.constants';
import {
  dateOnlyFromDateTime,
  parseDateOnly,
} from '../../domain/whatsapp/quote-schedule';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  CreateQuoteProposalDto,
  DecideQuoteProposalDto,
  QuoteProposalListQueryDto,
  SendQuoteProposalDto,
  UpdateQuoteProposalStatusDto,
  UploadQuoteProposalDocumentDto,
} from './dto/whatsapp.dto';

interface UploadedProposalFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

interface ProposalDocumentContent {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  content: Buffer;
}

function contentDisposition(fileName: string): string {
  const fallback =
    fileName
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/["\\\r\n]/g, '_')
      .slice(0, 180) || 'orcamento.pdf';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function assertCommercialDepartment(current: AuthenticatedPrincipal): void {
  if (!current.departments.includes('commercial')) {
    throw forbidden(
      'O acesso aos orçamentos é restrito a usuários vinculados ao departamento Comercial.',
    );
  }
}

@ApiTags('Propostas comerciais WhatsApp')
@ApiBearerAuth()
@RequireAnyPermission(
  'commercial:view',
  'commercial:manage',
  'whatsapp-conversations:view',
  'whatsapp-conversations:manage',
)
@Controller('whatsapp/quote-proposals')
export class QuoteProposalController {
  constructor(private readonly proposals: QuoteProposalUseCase) {}

  @Post()
  @RequireAnyPermission('commercial:manage', 'whatsapp-conversations:manage')
  @ApiCreatedResponse({
    description:
      'Nova solicitação comercial criada pelo atendente com versionamento otimista.',
  })
  create(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateQuoteProposalDto,
  ) {
    assertCommercialDepartment(current);
    const departureAt =
      body.departureAt && !/^\d{4}-\d{2}-\d{2}$/.test(body.departureAt)
        ? new Date(body.departureAt)
        : null;
    const returnAt =
      body.returnAt && !/^\d{4}-\d{2}-\d{2}$/.test(body.returnAt)
        ? new Date(body.returnAt)
        : null;
    return this.proposals.create({
      ...body,
      companyId: current.companyId,
      actorUserId: current.id,
      departureDate: body.departureDate
        ? parseDateOnly(body.departureDate, 'departureDate')
        : body.departureAt
          ? /^\d{4}-\d{2}-\d{2}$/.test(body.departureAt)
            ? parseDateOnly(body.departureAt, 'departureAt')
            : dateOnlyFromDateTime(new Date(body.departureAt))
          : null,
      departureAt,
      returnDate: body.returnDate
        ? parseDateOnly(body.returnDate, 'returnDate')
        : body.returnAt
          ? /^\d{4}-\d{2}-\d{2}$/.test(body.returnAt)
            ? parseDateOnly(body.returnAt, 'returnAt')
            : dateOnlyFromDateTime(new Date(body.returnAt))
          : null,
      returnAt,
    });
  }

  @Get()
  @ApiOkResponse({
    description: 'Fila comercial paginada de solicitações aguardando proposta.',
  })
  list(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: QuoteProposalListQueryDto,
  ) {
    assertCommercialDepartment(current);
    return this.proposals.list(current.companyId, query);
  }

  @Get(':quoteRequestId')
  detail(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('quoteRequestId', new ParseUUIDPipe()) quoteRequestId: string,
  ) {
    assertCommercialDepartment(current);
    return this.proposals.get(current.companyId, quoteRequestId);
  }

  @Patch(':quoteRequestId/decision')
  @RequireAnyPermission('commercial:manage', 'whatsapp-conversations:manage')
  @ApiOkResponse({
    description:
      'Registra aprovação ou recusa da proposta; a recusa exige motivo.',
  })
  decide(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('quoteRequestId', new ParseUUIDPipe()) quoteRequestId: string,
    @Body() body: DecideQuoteProposalDto,
  ) {
    assertCommercialDepartment(current);
    return this.proposals.decide({
      ...body,
      companyId: current.companyId,
      quoteRequestId,
      actorUserId: current.id,
    });
  }

  @Patch(':quoteRequestId/status')
  @RequireAnyPermission('commercial:manage', 'whatsapp-conversations:manage')
  @ApiOkResponse({
    description:
      'Altera manualmente o status comercial do orçamento atual, com concorrência otimista e auditoria do atendente.',
  })
  updateStatus(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('quoteRequestId', new ParseUUIDPipe()) quoteRequestId: string,
    @Body() body: UpdateQuoteProposalStatusDto,
  ) {
    assertCommercialDepartment(current);
    return this.proposals.updateStatus({
      ...body,
      companyId: current.companyId,
      quoteRequestId,
      actorUserId: current.id,
    });
  }

  @Post(':quoteRequestId/documents')
  @RequireAnyPermission('commercial:manage', 'whatsapp-conversations:manage')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: QUOTE_PROPOSAL_MAX_PDF_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'commandId', 'expectedVersion'],
      properties: {
        file: { type: 'string', format: 'binary' },
        commandId: { type: 'string', format: 'uuid' },
        expectedVersion: { type: 'integer', minimum: 1 },
      },
    },
  })
  @ApiCreatedResponse({
    description:
      'PDF validado e persistido; nenhuma mensagem é enviada nesta etapa.',
  })
  upload(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('quoteRequestId', new ParseUUIDPipe()) quoteRequestId: string,
    @Body() body: UploadQuoteProposalDocumentDto,
    @UploadedFile() file?: UploadedProposalFile,
  ) {
    assertCommercialDepartment(current);
    return this.proposals.upload({
      companyId: current.companyId,
      quoteRequestId,
      actorUserId: current.id,
      commandId: body.commandId,
      expectedVersion: body.expectedVersion,
      file: {
        originalName: file?.originalname ?? '',
        mimeType: file?.mimetype ?? '',
        sizeBytes: file?.size ?? 0,
        content: file?.buffer ?? Buffer.alloc(0),
      },
    });
  }

  @Post(':quoteRequestId/send')
  @RequireAnyPermission('commercial:manage', 'whatsapp-conversations:manage')
  @ApiCreatedResponse({
    description:
      'Mensagem document pending, tentativa e outbox criadas de forma atômica e idempotente.',
  })
  send(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('quoteRequestId', new ParseUUIDPipe()) quoteRequestId: string,
    @Body() body: SendQuoteProposalDto,
  ) {
    assertCommercialDepartment(current);
    return this.proposals.send({
      ...body,
      companyId: current.companyId,
      quoteRequestId,
      actorUserId: current.id,
    });
  }

  @Get(':quoteRequestId/documents/:documentId/content')
  @Header('Cache-Control', 'private, no-store')
  async download(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('quoteRequestId', new ParseUUIDPipe()) quoteRequestId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertCommercialDepartment(current);
    const document = (await this.proposals.getDocument(
      current.companyId,
      documentId,
    )) as ProposalDocumentContent & { quoteRequestId: string };
    if (document.quoteRequestId !== quoteRequestId) {
      throw notFound('Documento da proposta');
    }
    response.setHeader('Content-Type', document.mimeType);
    response.setHeader('Content-Length', String(document.sizeBytes));
    response.setHeader(
      'Content-Disposition',
      contentDisposition(document.fileName),
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Content-SHA256', document.sha256);
    return new StreamableFile(document.content);
  }
}
