import { SetMetadata } from '@nestjs/common';

import type { PermissionCode } from '../../../domain/access/access.constants';

export const REQUIRED_PERMISSIONS = Symbol('REQUIRED_PERMISSIONS');

export const RequireAnyPermission = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
