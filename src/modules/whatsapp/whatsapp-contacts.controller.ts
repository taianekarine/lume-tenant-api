import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  SaveWhatsAppContactDto,
  WhatsAppContactListQueryDto,
} from './dto/whatsapp-contacts.dto';
import {
  WhatsAppContactsService,
  type UploadedContactCsv,
} from './whatsapp-contacts.service';

@ApiTags('Contatos do WhatsApp')
@ApiBearerAuth()
@RequireAnyPermission(
  'whatsapp-conversations:view',
  'whatsapp-conversations:manage',
)
@Controller('whatsapp/contacts')
export class WhatsAppContactsController {
  constructor(private readonly contacts: WhatsAppContactsService) {}

  @Get()
  @ApiOkResponse({ description: 'Lista os contatos salvos da empresa.' })
  list(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: WhatsAppContactListQueryDto,
  ) {
    return this.contacts.list(current.companyId, query);
  }

  @Post()
  @RequireAnyPermission('whatsapp-conversations:manage')
  @ApiCreatedResponse({ description: 'Salva um contato.' })
  create(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: SaveWhatsAppContactDto,
  ) {
    return this.contacts.create(current.companyId, body);
  }

  @Patch(':contactId')
  @RequireAnyPermission('whatsapp-conversations:manage')
  update(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body() body: SaveWhatsAppContactDto,
  ) {
    return this.contacts.update(current.companyId, contactId, body);
  }

  @Delete(':contactId')
  @RequireAnyPermission('whatsapp-conversations:manage')
  delete(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
  ) {
    return this.contacts.delete(current.companyId, contactId);
  }

  @Post('import')
  @RequireAnyPermission('whatsapp-conversations:manage')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: 10 * 1024 * 1024 },
    }),
  )
  importCsv(
    @CurrentUser() current: AuthenticatedPrincipal,
    @UploadedFile() file: UploadedContactCsv | undefined,
  ) {
    return this.contacts.importCsv(current.companyId, file);
  }
}
