import {
  AccessTokenService,
  OfflineLicenseVerifier,
  PasswordHasher,
  RefreshTokenService,
  type AccessTokenPayload,
  type IssuedRefreshToken,
  type OfflineLicenseStatus,
  type ParsedRefreshToken,
} from '../../src/application/contracts/cryptography';
import {
  RefreshTokensRepository,
  RolesRepository,
  TenantBootstrapRepository,
  UsersRepository,
  type BootstrapTenantPersistenceInput,
  type RefreshTokenRecord,
  type UpdateUserPersistenceInput,
  type UserListQuery,
  type UserWithRoles,
} from '../../src/application/contracts/repositories';
import { Company } from '../../src/domain/entities/company';
import { Role } from '../../src/domain/entities/role';
import { User } from '../../src/domain/entities/user';

export class InMemoryStore {
  companies: Company[] = [];
  users: User[] = [];
  roles: Role[] = [];
  userRoles: Array<{ userId: string; roleId: string; companyId: string }> = [];
  refreshTokens: RefreshTokenRecord[] = [];
}

function withRoles(store: InMemoryStore, user: User): UserWithRoles {
  return {
    user,
    roles: store.userRoles
      .filter((assignment) => assignment.userId === user.id)
      .map((assignment) =>
        store.roles.find((role) => role.id === assignment.roleId),
      )
      .filter((role): role is Role => Boolean(role)),
    companyIsActive:
      store.companies.find((company) => company.id === user.companyId)?.props
        .status === 'ACTIVE',
  };
}

export class InMemoryTenantBootstrapRepository extends TenantBootstrapRepository {
  constructor(private readonly store: InMemoryStore) {
    super();
  }

  async isInitialized() {
    return this.store.companies.length > 0;
  }

  async createWithAdministrator(input: BootstrapTenantPersistenceInput) {
    this.store.companies.push(input.company);
    this.store.users.push(input.administrator);
    this.store.roles.push(...input.roles);
    this.store.userRoles.push({
      companyId: input.company.id,
      userId: input.administrator.id,
      roleId: input.administratorRoleId,
    });
  }
}

export class InMemoryUsersRepository extends UsersRepository {
  constructor(private readonly store: InMemoryStore) {
    super();
  }

  async loginIdentifierExists(input: {
    usernameNormalized?: string;
    emailNormalized?: string;
    cpfNormalized?: string | null;
    exceptUserId?: string;
  }): Promise<'username' | 'email' | 'cpf' | null> {
    const users = this.store.users.filter(
      (user) => user.id !== input.exceptUserId,
    );
    if (
      input.usernameNormalized &&
      users.some(
        (user) => user.props.usernameNormalized === input.usernameNormalized,
      )
    ) {
      return 'username';
    }
    if (
      input.emailNormalized &&
      users.some((user) => user.props.emailNormalized === input.emailNormalized)
    ) {
      return 'email';
    }
    if (
      input.cpfNormalized &&
      users.some((user) => user.props.cpfNormalized === input.cpfNormalized)
    ) {
      return 'cpf';
    }
    return null;
  }

  async findByLoginIdentifier(identifier: string) {
    const normalized = identifier.trim().toLocaleLowerCase('pt-BR');
    const digits = identifier.replace(/\D/g, '');
    const user = this.store.users.find(
      (candidate) =>
        candidate.props.usernameNormalized === normalized ||
        candidate.props.emailNormalized === normalized ||
        (digits.length === 11 && candidate.props.cpfNormalized === digits),
    );
    return user ? withRoles(this.store, user) : null;
  }

  async findById(companyId: string, userId: string) {
    const user = this.store.users.find(
      (candidate) =>
        candidate.companyId === companyId && candidate.id === userId,
    );
    return user ? withRoles(this.store, user) : null;
  }

  async create(user: User, roleIds: readonly string[]) {
    this.store.users.push(user);
    this.store.userRoles.push(
      ...roleIds.map((roleId) => ({
        companyId: user.companyId,
        userId: user.id,
        roleId,
      })),
    );
    return withRoles(this.store, user);
  }

  async list(companyId: string, query: UserListQuery) {
    const filtered = this.store.users
      .filter((user) => user.companyId === companyId)
      .filter(
        (user) =>
          query.isActive === undefined ||
          user.props.isActive === query.isActive,
      )
      .filter((user) => {
        if (!query.search) return true;
        const search = query.search.toLocaleLowerCase('pt-BR');
        return [user.props.name, user.props.email, user.props.username].some(
          (value) => value.toLocaleLowerCase('pt-BR').includes(search),
        );
      });
    return {
      items: filtered
        .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
        .map((user) => withRoles(this.store, user)),
      total: filtered.length,
    };
  }

  async update(
    companyId: string,
    userId: string,
    input: UpdateUserPersistenceInput,
  ) {
    const index = this.store.users.findIndex(
      (user) => user.companyId === companyId && user.id === userId,
    );
    const current = this.store.users[index];
    if (!current) throw new Error('Missing user.');
    const updated = User.restore({
      ...current.props,
      name: input.name ?? current.props.name,
      email: input.email ?? current.props.email,
      emailNormalized: input.emailNormalized ?? current.props.emailNormalized,
      cpfNormalized:
        input.cpfNormalized === undefined
          ? current.props.cpfNormalized
          : input.cpfNormalized,
      departments: input.departments ?? current.props.departments,
      isActive: input.isActive ?? current.props.isActive,
      tokenVersion:
        input.isActive !== undefined ||
        input.roleIds !== undefined ||
        input.departments !== undefined
          ? current.props.tokenVersion + 1
          : current.props.tokenVersion,
      updatedAt: new Date(),
    });
    this.store.users[index] = updated;
    if (input.roleIds) {
      this.store.userRoles = this.store.userRoles.filter(
        (assignment) => assignment.userId !== userId,
      );
      this.store.userRoles.push(
        ...input.roleIds.map((roleId) => ({
          companyId,
          userId,
          roleId,
        })),
      );
    }
    return withRoles(this.store, updated);
  }

  async markLastLogin(companyId: string, userId: string, date: Date) {
    const index = this.store.users.findIndex(
      (user) => user.companyId === companyId && user.id === userId,
    );
    const current = this.store.users[index];
    if (current) {
      this.store.users[index] = User.restore({
        ...current.props,
        lastLoginAt: date,
      });
    }
  }

  async countActiveByRole(companyId: string, roleId: string) {
    return this.store.userRoles.filter((assignment) => {
      const user = this.store.users.find(
        (candidate) => candidate.id === assignment.userId,
      );
      return (
        assignment.companyId === companyId &&
        assignment.roleId === roleId &&
        user?.props.isActive
      );
    }).length;
  }
}

export class InMemoryRolesRepository extends RolesRepository {
  constructor(private readonly store: InMemoryStore) {
    super();
  }

  async list(companyId: string) {
    return this.store.roles.filter((role) => role.companyId === companyId);
  }
  async findById(companyId: string, roleId: string) {
    return (
      this.store.roles.find(
        (role) => role.companyId === companyId && role.id === roleId,
      ) ?? null
    );
  }
  async findByIds(companyId: string, roleIds: readonly string[]) {
    return this.store.roles.filter(
      (role) => role.companyId === companyId && roleIds.includes(role.id),
    );
  }
  async findByCode(companyId: string, code: string) {
    return (
      this.store.roles.find(
        (role) => role.companyId === companyId && role.code === code,
      ) ?? null
    );
  }
  async codeExists(companyId: string, code: string, exceptRoleId?: string) {
    return this.store.roles.some(
      (role) =>
        role.companyId === companyId &&
        role.code === code &&
        role.id !== exceptRoleId,
    );
  }
  async create(role: Role) {
    this.store.roles.push(role);
    return role;
  }
  async update(role: Role) {
    const index = this.store.roles.findIndex(
      (candidate) => candidate.id === role.id,
    );
    this.store.roles[index] = role;
    return role;
  }
  async delete(companyId: string, roleId: string) {
    this.store.roles = this.store.roles.filter(
      (role) => role.companyId !== companyId || role.id !== roleId,
    );
  }
  async countAssignments(companyId: string, roleId: string) {
    return this.store.userRoles.filter(
      (assignment) =>
        assignment.companyId === companyId && assignment.roleId === roleId,
    ).length;
  }
}

export class InMemoryRefreshTokensRepository extends RefreshTokensRepository {
  constructor(private readonly store: InMemoryStore) {
    super();
  }
  async create(token: RefreshTokenRecord) {
    this.store.refreshTokens.push(token);
  }
  async findById(id: string) {
    return this.store.refreshTokens.find((token) => token.id === id) ?? null;
  }
  async rotate(currentId: string, nextToken: RefreshTokenRecord) {
    const current = this.store.refreshTokens.find(
      (token) => token.id === currentId,
    );
    if (current) current.revokedAt = new Date();
    this.store.refreshTokens.push(nextToken);
  }
  async revoke(id: string, revokedAt: Date) {
    const token = this.store.refreshTokens.find((item) => item.id === id);
    if (token) token.revokedAt = revokedAt;
  }
  async revokeAllForUser(companyId: string, userId: string, revokedAt: Date) {
    for (const token of this.store.refreshTokens) {
      if (token.companyId === companyId && token.userId === userId) {
        token.revokedAt = revokedAt;
      }
    }
  }
}

export class FakePasswordHasher extends PasswordHasher {
  async hash(plainText: string) {
    return `hashed:${plainText}`;
  }
  async compare(plainText: string, hash: string) {
    return hash === `hashed:${plainText}`;
  }
}

export class FakeAccessTokenService extends AccessTokenService {
  readonly expiresInSeconds = 900;
  async sign(payload: AccessTokenPayload) {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }
  async verify(token: string) {
    return JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8'),
    ) as AccessTokenPayload;
  }
}

export class FakeRefreshTokenService extends RefreshTokenService {
  private counter = 0;
  issue(): IssuedRefreshToken {
    this.counter += 1;
    const id = `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
    return {
      id,
      plainText: `${id}.secret-${this.counter}`,
      hash: `hash-${this.counter}`,
    };
  }
  parse(token: string): ParsedRefreshToken | null {
    const [id, secret] = token.split('.');
    if (!id || !secret) return null;
    const index = secret.replace('secret-', '');
    return { id, hash: `hash-${index}` };
  }
  matches(firstHash: string, secondHash: string) {
    return firstHash === secondHash;
  }
}

export class FakeOfflineLicenseVerifier extends OfflineLicenseVerifier {
  constructor(
    private readonly tenantId = '00000000-0000-4000-8000-000000000010',
  ) {
    super();
  }
  status(): OfflineLicenseStatus {
    return {
      state: 'active',
      payload: {
        version: 1,
        licenseId: '00000000-0000-4000-8000-000000000001',
        installationId: '00000000-0000-4000-8000-000000000002',
        tenantId: this.tenantId,
        plan: 'standard',
        features: ['users', 'roles'],
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
        graceUntil: '2030-02-01T00:00:00.000Z',
      },
    };
  }
}
