import { Module } from '@nestjs/common';

import { DocumentManagementUseCase } from '../../application/use-cases/documents/document-management.use-case';
import { DocumentManagementController } from './document-management.controller';

@Module({
  controllers: [DocumentManagementController],
  providers: [DocumentManagementUseCase],
})
export class DocumentManagementModule {}
