import { randomUUID } from 'node:crypto';

import { validationError } from '../../core/errors/app-error';
import {
  isPermissionCode,
  type PermissionCode,
} from '../access/access.constants';

export interface RoleProps {
  id: string;
  companyId: string;
  code: string;
  name: string;
  description: string | null;
  permissionCodes: PermissionCode[];
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class Role {
  private constructor(public readonly props: RoleProps) {}

  static create(input: {
    companyId: string;
    code: string;
    name: string;
    description?: string;
    permissionCodes: readonly string[];
    isSystem?: boolean;
  }): Role {
    const invalidPermission = input.permissionCodes.find(
      (code) => !isPermissionCode(code),
    );

    if (invalidPermission) {
      throw validationError(`Permissão desconhecida: ${invalidPermission}.`);
    }

    const now = new Date();

    return new Role({
      id: randomUUID(),
      companyId: input.companyId,
      code: input.code.trim().toLocaleLowerCase('pt-BR'),
      name: input.name.trim(),
      description: input.description?.trim() || null,
      permissionCodes: Array.from(
        new Set(input.permissionCodes),
      ).sort() as PermissionCode[],
      isSystem: input.isSystem ?? false,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: RoleProps): Role {
    return new Role(props);
  }

  get id(): string {
    return this.props.id;
  }

  get companyId(): string {
    return this.props.companyId;
  }

  get code(): string {
    return this.props.code;
  }

  get name(): string {
    return this.props.name;
  }

  get description(): string | null {
    return this.props.description;
  }

  get permissionCodes(): PermissionCode[] {
    return this.props.permissionCodes;
  }

  get isSystem(): boolean {
    return this.props.isSystem;
  }
}
