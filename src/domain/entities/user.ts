import { randomUUID } from 'node:crypto';

import type {
  PermissionCode,
  UserDepartment,
} from '../access/access.constants';

export type UserAccountStatus = 'active' | 'inactive' | 'suspended';
export type DocumentAccessMode = 'standard' | 'document-portal';
export type MaritalStatus =
  | 'single'
  | 'married'
  | 'stable-union'
  | 'divorced'
  | 'widowed'
  | 'not-informed';
export type MilitaryDocumentStatus =
  'applicable' | 'not-applicable' | 'pending-confirmation';
export interface UserDependent {
  readonly name: string;
  readonly birthDate: string;
  readonly relationship?: string;
}
export const USERNAME_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9._-]{3,40}$/;

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value);
}

export interface UserProps {
  id: string;
  companyId: string;
  name: string;
  username: string;
  usernameNormalized: string;
  email: string;
  emailNormalized: string;
  cpfNormalized: string | null;
  passwordHash: string;
  mustChangePassword: boolean;
  profilePicture: Uint8Array<ArrayBuffer> | null;
  profilePictureMime: string | null;
  isAdministrator: boolean;
  documentAccessMode: DocumentAccessMode;
  jobTitle: string | null;
  maritalStatus: MaritalStatus | null;
  militaryDocumentStatus: MilitaryDocumentStatus;
  dependents: UserDependent[];
  departments: UserDepartment[];
  permissionCodes: PermissionCode[];
  status: UserAccountStatus;
  suspendedUntil: Date | null;
  suspensionReason: string | null;
  isActive: boolean;
  tokenVersion: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class User {
  private constructor(public readonly props: UserProps) {}

  static create(
    input: Omit<
      UserProps,
      | 'id'
      | 'isActive'
      | 'tokenVersion'
      | 'lastLoginAt'
      | 'mustChangePassword'
      | 'profilePicture'
      | 'profilePictureMime'
      | 'isAdministrator'
      | 'documentAccessMode'
      | 'jobTitle'
      | 'maritalStatus'
      | 'militaryDocumentStatus'
      | 'dependents'
      | 'permissionCodes'
      | 'status'
      | 'suspendedUntil'
      | 'suspensionReason'
      | 'createdAt'
      | 'updatedAt'
    > & {
      mustChangePassword?: boolean;
      isAdministrator?: boolean;
      documentAccessMode?: DocumentAccessMode;
      jobTitle?: string | null;
      maritalStatus?: MaritalStatus | null;
      militaryDocumentStatus?: MilitaryDocumentStatus;
      dependents?: UserDependent[];
      permissionCodes?: PermissionCode[];
    },
  ): User {
    if (!isValidUsername(input.usernameNormalized)) {
      throw new Error(
        'O usuário deve possuir entre 3 e 40 caracteres permitidos e ao menos uma letra.',
      );
    }
    const now = new Date();

    return new User({
      ...input,
      id: randomUUID(),
      isActive: true,
      tokenVersion: 1,
      mustChangePassword: input.mustChangePassword ?? false,
      profilePicture: null,
      profilePictureMime: null,
      isAdministrator: input.isAdministrator ?? false,
      documentAccessMode: input.documentAccessMode ?? 'standard',
      jobTitle: input.jobTitle ?? null,
      maritalStatus: input.maritalStatus ?? null,
      militaryDocumentStatus:
        input.militaryDocumentStatus ?? 'pending-confirmation',
      dependents: input.dependents ?? [],
      permissionCodes: input.permissionCodes ?? [],
      status: 'active',
      suspendedUntil: null,
      suspensionReason: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(
    props: Omit<
      UserProps,
      | 'documentAccessMode'
      | 'jobTitle'
      | 'maritalStatus'
      | 'militaryDocumentStatus'
      | 'dependents'
    > & {
      documentAccessMode?: DocumentAccessMode;
      jobTitle?: string | null;
      maritalStatus?: MaritalStatus | null;
      militaryDocumentStatus?: MilitaryDocumentStatus;
      dependents?: UserDependent[];
    },
  ): User {
    return new User({
      ...props,
      documentAccessMode: props.documentAccessMode ?? 'standard',
      jobTitle: props.jobTitle ?? null,
      maritalStatus: props.maritalStatus ?? null,
      militaryDocumentStatus:
        props.militaryDocumentStatus ?? 'pending-confirmation',
      dependents: props.dependents ?? [],
    });
  }

  get id(): string {
    return this.props.id;
  }

  get companyId(): string {
    return this.props.companyId;
  }
}
