import { describe, expect, it } from 'vitest';

import { REQUIRED_PERMISSIONS } from '../../shared/http/decorators/require-permissions.decorator';
import { DocumentManagementController } from './document-management.controller';

function permissionsFor(
  method: keyof DocumentManagementController,
): readonly string[] {
  const handler = Object.getOwnPropertyDescriptor(
    DocumentManagementController.prototype,
    method,
  )?.value as object;
  return Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as string[];
}

describe('DocumentManagementController permissions', () => {
  it('keeps self-service, management, review and export permissions separate', () => {
    expect(permissionsFor('listRequests')).toEqual([
      'documents:view',
      'documents:manage',
    ]);
    expect(permissionsFor('upload')).toEqual([
      'documents:create',
      'documents:update',
      'documents:manage',
    ]);
    expect(permissionsFor('review')).toEqual(['documents:approve']);
    expect(permissionsFor('exportXlsx')).toEqual(['documents:export']);
    expect(permissionsFor('createBatchRequests')).toEqual(['documents:manage']);
  });

  it('does not allow automatic validation to use the approval permission', () => {
    expect(permissionsFor('completeSubmission')).not.toContain(
      'documents:approve',
    );
  });
});
