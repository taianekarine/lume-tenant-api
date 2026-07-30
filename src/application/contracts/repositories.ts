import type {
  PermissionCode,
  UserDepartment,
} from '../../domain/access/access.constants';
import type { Company } from '../../domain/entities/company';
import type { User } from '../../domain/entities/user';
import type { UserAccountStatus } from '../../domain/entities/user';

export interface UserRecord {
  user: User;
  companyIsActive: boolean;
}

export interface BootstrapTenantPersistenceInput {
  company: Company;
  administrator: User;
  departments: Array<{
    code: UserDepartment;
    name: string;
    isDefault: boolean;
  }>;
}

export abstract class TenantBootstrapRepository {
  abstract isInitialized(): Promise<boolean>;
  abstract createWithAdministrator(
    input: BootstrapTenantPersistenceInput,
  ): Promise<void>;
}

export interface UserListQuery {
  page: number;
  pageSize: number;
  search?: string;
  department?: UserDepartment;
  permission?: PermissionCode;
  status?: UserAccountStatus;
}

export interface UserListResult {
  items: UserRecord[];
  total: number;
}

export interface UpdateUserPersistenceInput {
  name?: string;
  email?: string;
  emailNormalized?: string;
  cpfNormalized?: string | null;
  isAdministrator?: boolean;
  departments?: UserDepartment[];
  permissionCodes?: PermissionCode[];
}

export interface UpdateUserStatusPersistenceInput {
  status: UserAccountStatus;
  suspendedUntil: Date | null;
  suspensionReason: string | null;
  changedAt: Date;
}

export interface PasswordChangeChallengeRecord {
  id: string;
  companyId: string;
  userId: string;
  tokenHash: string;
  reason: 'first-access' | 'admin-reset';
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface CompletePasswordChangePersistenceInput {
  companyId: string;
  userId: string;
  challengeId: string;
  passwordHash: string;
  changedAt: Date;
}

export interface UserProfileRecord {
  id: string;
  name: string;
  username: string;
  email: string;
  profilePicture: Uint8Array<ArrayBuffer> | null;
  profilePictureMime: string | null;
}

export abstract class UsersRepository {
  abstract loginIdentifierExists(input: {
    usernameNormalized?: string;
    emailNormalized?: string;
    cpfNormalized?: string | null;
    exceptUserId?: string;
  }): Promise<'username' | 'email' | 'cpf' | null>;
  abstract findByLoginIdentifier(
    identifier: string,
  ): Promise<UserRecord | null>;
  abstract findById(
    companyId: string,
    userId: string,
  ): Promise<UserRecord | null>;
  abstract findProfileById(
    companyId: string,
    userId: string,
  ): Promise<UserProfileRecord | null>;
  abstract create(user: User): Promise<UserRecord>;
  abstract list(
    companyId: string,
    query: UserListQuery,
  ): Promise<UserListResult>;
  abstract update(
    companyId: string,
    userId: string,
    input: UpdateUserPersistenceInput,
  ): Promise<UserRecord>;
  abstract updateWithAdministratorInvariant(
    companyId: string,
    userId: string,
    input: UpdateUserPersistenceInput,
  ): Promise<UserRecord | null>;
  abstract updateStatus(
    companyId: string,
    userId: string,
    input: UpdateUserStatusPersistenceInput,
  ): Promise<UserRecord>;
  abstract updateStatusWithAdministratorInvariant(
    companyId: string,
    userId: string,
    input: UpdateUserStatusPersistenceInput,
  ): Promise<UserRecord | null>;
  abstract markLastLogin(
    companyId: string,
    userId: string,
    date: Date,
  ): Promise<void>;
  abstract countActiveAdministrators(companyId: string): Promise<number>;
  abstract listPasswordHashes(
    companyId: string,
    userId: string,
    limit: number,
  ): Promise<string[]>;
  abstract changePassword(
    companyId: string,
    userId: string,
    passwordHash: string,
    changedAt: Date,
  ): Promise<void>;
  abstract requirePasswordChange(
    companyId: string,
    userId: string,
  ): Promise<void>;
  abstract updateProfilePicture(
    companyId: string,
    userId: string,
    picture: Uint8Array<ArrayBuffer> | null,
    mimeType: string | null,
  ): Promise<UserProfileRecord>;
}

export abstract class PasswordChangeChallengesRepository {
  abstract replaceForUser(
    challenge: PasswordChangeChallengeRecord,
  ): Promise<void>;
  abstract findById(id: string): Promise<PasswordChangeChallengeRecord | null>;
  abstract complete(
    input: CompletePasswordChangePersistenceInput,
  ): Promise<boolean>;
  abstract cancelReplacement(input: {
    challengeId: string;
    companyId: string;
    userId: string;
    replacedAt: Date;
  }): Promise<void>;
  abstract delete(id: string): Promise<void>;
}

export interface RefreshTokenRecord {
  id: string;
  companyId: string;
  userId: string;
  tokenHash: string;
  rememberDevice: boolean;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export abstract class RefreshTokensRepository {
  abstract create(token: RefreshTokenRecord): Promise<void>;
  abstract findById(id: string): Promise<RefreshTokenRecord | null>;
  abstract rotate(
    currentId: string,
    nextToken: RefreshTokenRecord,
  ): Promise<void>;
  abstract revoke(id: string, revokedAt: Date): Promise<void>;
  abstract revokeAllForUser(
    companyId: string,
    userId: string,
    revokedAt: Date,
  ): Promise<void>;
}

export abstract class TenantAuditLogsRepository {
  abstract create(input: {
    companyId: string;
    actorUserId?: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}
