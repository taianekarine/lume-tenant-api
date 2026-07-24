import type { Department } from '../../domain/access/access.constants';
import type { Company } from '../../domain/entities/company';
import type { Role } from '../../domain/entities/role';
import type { User } from '../../domain/entities/user';

export interface UserWithRoles {
  user: User;
  roles: Role[];
  companyIsActive: boolean;
}

export interface BootstrapTenantPersistenceInput {
  company: Company;
  administrator: User;
  roles: Role[];
  administratorRoleId: string;
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
  isActive?: boolean;
}

export interface UserListResult {
  items: UserWithRoles[];
  total: number;
}

export interface UpdateUserPersistenceInput {
  name?: string;
  email?: string;
  emailNormalized?: string;
  cpfNormalized?: string | null;
  departments?: Department[];
  isActive?: boolean;
  roleIds?: string[];
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
  ): Promise<UserWithRoles | null>;
  abstract findById(
    companyId: string,
    userId: string,
  ): Promise<UserWithRoles | null>;
  abstract create(
    user: User,
    roleIds: readonly string[],
  ): Promise<UserWithRoles>;
  abstract list(
    companyId: string,
    query: UserListQuery,
  ): Promise<UserListResult>;
  abstract update(
    companyId: string,
    userId: string,
    input: UpdateUserPersistenceInput,
  ): Promise<UserWithRoles>;
  abstract markLastLogin(
    companyId: string,
    userId: string,
    date: Date,
  ): Promise<void>;
  abstract countActiveByRole(
    companyId: string,
    roleId: string,
  ): Promise<number>;
}

export abstract class RolesRepository {
  abstract list(companyId: string): Promise<Role[]>;
  abstract findById(companyId: string, roleId: string): Promise<Role | null>;
  abstract findByIds(
    companyId: string,
    roleIds: readonly string[],
  ): Promise<Role[]>;
  abstract findByCode(companyId: string, code: string): Promise<Role | null>;
  abstract codeExists(
    companyId: string,
    code: string,
    exceptRoleId?: string,
  ): Promise<boolean>;
  abstract create(role: Role): Promise<Role>;
  abstract update(role: Role): Promise<Role>;
  abstract delete(companyId: string, roleId: string): Promise<void>;
  abstract countAssignments(companyId: string, roleId: string): Promise<number>;
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
