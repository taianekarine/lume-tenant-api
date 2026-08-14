import {
  AccessTokenService,
  OfflineLicenseVerifier,
  PasswordChangeTokenService,
  PasswordHasher,
  RefreshTokenService,
  type AccessTokenPayload,
  type IssuedRefreshToken,
  type OfflineLicenseStatus,
  type ParsedRefreshToken,
} from '../../src/application/contracts/cryptography';
import {
  RefreshTokensRepository,
  PasswordChangeChallengesRepository,
  TenantBootstrapRepository,
  UsersRepository,
  type BootstrapTenantPersistenceInput,
  type CompletePasswordChangePersistenceInput,
  type RefreshTokenRecord,
  type PasswordChangeChallengeRecord,
  type UserProfileRecord,
  type UpdateUserPersistenceInput,
  type UpdateUserStatusPersistenceInput,
  type UserListQuery,
  type UserRecord,
} from '../../src/application/contracts/repositories';
import { Company } from '../../src/domain/entities/company';
import { User } from '../../src/domain/entities/user';
import { resolveEffectivePermissions } from '../../src/domain/access/resolve-permissions';

export class InMemoryStore {
  companies: Company[] = [];
  users: User[] = [];
  tenantDepartments: Array<{
    companyId: string;
    code: string;
    name: string;
    isDefault: boolean;
  }> = [];
  refreshTokens: RefreshTokenRecord[] = [];
  passwordChallenges: PasswordChangeChallengeRecord[] = [];
  passwordHistory: Array<{
    companyId: string;
    userId: string;
    passwordHash: string;
    createdAt: Date;
  }> = [];
}

function toUserRecord(store: InMemoryStore, user: User): UserRecord {
  return {
    user,
    companyIsActive:
      store.companies.find((company) => company.id === user.companyId)?.props
        .status === 'ACTIVE',
  };
}

function profileRecord(user: User): UserProfileRecord {
  return {
    id: user.id,
    name: user.props.name,
    username: user.props.username,
    email: user.props.email,
    profilePicture: user.props.profilePicture,
    profilePictureMime: user.props.profilePictureMime,
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
    this.store.tenantDepartments.push(
      ...input.departments.map((department) => ({
        companyId: input.company.id,
        ...department,
      })),
    );
  }
}

export class InMemoryUsersRepository extends UsersRepository {
  constructor(private readonly store: InMemoryStore) {
    super();
  }

  private reactivateExpiredSuspensions() {
    const now = new Date();
    this.store.users = this.store.users.map((user) => {
      if (
        user.props.status !== 'suspended' ||
        !user.props.suspendedUntil ||
        user.props.suspendedUntil > now
      ) {
        return user;
      }
      return User.restore({
        ...user.props,
        status: 'active',
        isActive: true,
        suspendedUntil: null,
        suspensionReason: null,
        tokenVersion: user.props.tokenVersion + 1,
        updatedAt: now,
      });
    });
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
    this.reactivateExpiredSuspensions();
    const normalized = identifier.trim().toLocaleLowerCase('pt-BR');
    const user = this.store.users.find(
      (candidate) =>
        candidate.props.usernameNormalized === normalized ||
        candidate.props.emailNormalized === normalized,
    );
    return user ? toUserRecord(this.store, user) : null;
  }

  async findById(companyId: string, userId: string) {
    this.reactivateExpiredSuspensions();
    const user = this.store.users.find(
      (candidate) =>
        candidate.companyId === companyId && candidate.id === userId,
    );
    return user ? toUserRecord(this.store, user) : null;
  }

  async findProfileById(companyId: string, userId: string) {
    const user = this.store.users.find(
      (candidate) =>
        candidate.companyId === companyId && candidate.id === userId,
    );
    return user ? profileRecord(user) : null;
  }

  async create(user: User) {
    this.store.users.push(user);
    return toUserRecord(this.store, user);
  }

  async list(companyId: string, query: UserListQuery) {
    this.reactivateExpiredSuspensions();
    const filtered = this.store.users
      .filter((user) => user.companyId === companyId)
      .filter(
        (user) =>
          !query.department ||
          user.props.isAdministrator ||
          user.props.departments.includes(query.department),
      )
      .filter(
        (user) =>
          !query.permission ||
          resolveEffectivePermissions(
            user.props.departments,
            user.props.permissionCodes,
            user.props.isAdministrator,
          ).includes(query.permission),
      )
      .filter((user) => !query.status || user.props.status === query.status)
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
        .map((user) => toUserRecord(this.store, user)),
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
      isAdministrator: input.isAdministrator ?? current.props.isAdministrator,
      documentAccessMode:
        input.documentAccessMode ?? current.props.documentAccessMode,
      departments: input.departments ?? current.props.departments,
      permissionCodes: input.permissionCodes ?? current.props.permissionCodes,
      tokenVersion:
        input.permissionCodes !== undefined ||
        input.departments !== undefined ||
        input.isAdministrator !== undefined ||
        input.documentAccessMode !== undefined
          ? current.props.tokenVersion + 1
          : current.props.tokenVersion,
      updatedAt: new Date(),
    });
    this.store.users[index] = updated;
    return toUserRecord(this.store, updated);
  }

  updateWithAdministratorInvariant(
    companyId: string,
    userId: string,
    input: UpdateUserPersistenceInput,
  ) {
    const activeAdministrators = this.store.users.filter(
      (user) =>
        user.companyId === companyId &&
        user.props.isActive &&
        user.props.status === 'active' &&
        user.props.isAdministrator,
    ).length;
    if (activeAdministrators <= 1) {
      return Promise.resolve(null);
    }
    return this.update(companyId, userId, input);
  }

  async updateStatus(
    companyId: string,
    userId: string,
    input: UpdateUserStatusPersistenceInput,
  ) {
    const index = this.store.users.findIndex(
      (user) => user.companyId === companyId && user.id === userId,
    );
    const current = this.store.users[index];
    if (!current) throw new Error('Missing user.');
    const updated = User.restore({
      ...current.props,
      status: input.status,
      isActive: input.status === 'active',
      suspendedUntil: input.suspendedUntil,
      suspensionReason: input.suspensionReason,
      tokenVersion: current.props.tokenVersion + 1,
      updatedAt: input.changedAt,
    });
    this.store.users[index] = updated;
    for (const token of this.store.refreshTokens) {
      if (
        token.companyId === companyId &&
        token.userId === userId &&
        !token.revokedAt
      ) {
        token.revokedAt = input.changedAt;
      }
    }
    return toUserRecord(this.store, updated);
  }

  updateStatusWithAdministratorInvariant(
    companyId: string,
    userId: string,
    input: UpdateUserStatusPersistenceInput,
  ) {
    const activeAdministrators = this.store.users.filter(
      (user) =>
        user.companyId === companyId &&
        user.props.isActive &&
        user.props.status === 'active' &&
        user.props.isAdministrator,
    ).length;
    if (activeAdministrators <= 1) {
      return Promise.resolve(null);
    }
    return this.updateStatus(companyId, userId, input);
  }

  async softDelete(companyId: string, userId: string) {
    const index = this.store.users.findIndex(
      (user) => user.companyId === companyId && user.id === userId,
    );
    if (index < 0) return false;
    const target = this.store.users[index];
    if (target.props.isAdministrator) {
      const activeAdministrators = this.store.users.filter(
        (user) =>
          user.companyId === companyId &&
          user.props.isAdministrator &&
          user.props.isActive &&
          user.props.status === 'active',
      ).length;
      if (activeAdministrators <= 1) return false;
    }
    this.store.users.splice(index, 1);
    return true;
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

  async countActiveAdministrators(companyId: string) {
    return this.store.users.filter(
      (user) =>
        user.companyId === companyId &&
        user.props.isActive &&
        user.props.status === 'active' &&
        user.props.isAdministrator,
    ).length;
  }

  async listPasswordHashes(companyId: string, userId: string, limit: number) {
    const current = this.store.users.find(
      (user) => user.companyId === companyId && user.id === userId,
    );
    const history = this.store.passwordHistory
      .filter(
        (entry) => entry.companyId === companyId && entry.userId === userId,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((entry) => entry.passwordHash);
    return current
      ? [current.props.passwordHash, ...history].slice(0, limit)
      : [];
  }

  async changePassword(
    companyId: string,
    userId: string,
    passwordHash: string,
    changedAt: Date,
  ) {
    const index = this.store.users.findIndex(
      (user) => user.companyId === companyId && user.id === userId,
    );
    const current = this.store.users[index];
    if (!current) throw new Error('Missing user.');
    this.store.passwordHistory.push({
      companyId,
      userId,
      passwordHash: current.props.passwordHash,
      createdAt: changedAt,
    });
    this.store.users[index] = User.restore({
      ...current.props,
      passwordHash,
      mustChangePassword: false,
      tokenVersion: current.props.tokenVersion + 1,
      updatedAt: changedAt,
    });
    for (const token of this.store.refreshTokens) {
      if (token.companyId === companyId && token.userId === userId) {
        token.revokedAt = changedAt;
      }
    }
  }

  async requirePasswordChange(companyId: string, userId: string) {
    const index = this.store.users.findIndex(
      (user) => user.companyId === companyId && user.id === userId,
    );
    const current = this.store.users[index];
    if (!current) throw new Error('Missing user.');
    this.store.users[index] = User.restore({
      ...current.props,
      mustChangePassword: true,
      tokenVersion: current.props.tokenVersion + 1,
      updatedAt: new Date(),
    });
  }

  async updateProfilePicture(
    companyId: string,
    userId: string,
    picture: Uint8Array<ArrayBuffer> | null,
    mimeType: string | null,
  ) {
    const index = this.store.users.findIndex(
      (user) => user.companyId === companyId && user.id === userId,
    );
    const current = this.store.users[index];
    if (!current) throw new Error('Missing user.');
    this.store.users[index] = User.restore({
      ...current.props,
      profilePicture: picture,
      profilePictureMime: mimeType,
      updatedAt: new Date(),
    });
    return profileRecord(this.store.users[index]);
  }
}

export class InMemoryPasswordChangeChallengesRepository extends PasswordChangeChallengesRepository {
  constructor(private readonly store: InMemoryStore) {
    super();
  }

  async create(challenge: PasswordChangeChallengeRecord) {
    this.store.passwordChallenges.push(challenge);
  }

  async replaceForUser(challenge: PasswordChangeChallengeRecord) {
    for (const current of this.store.passwordChallenges) {
      if (
        current.companyId === challenge.companyId &&
        current.userId === challenge.userId &&
        current.consumedAt === null
      ) {
        current.consumedAt = challenge.createdAt;
      }
    }
    this.store.passwordChallenges.push(challenge);
  }

  async cancelReplacement(input: {
    challengeId: string;
    companyId: string;
    userId: string;
    replacedAt: Date;
  }) {
    const current = this.store.passwordChallenges.find(
      (challenge) =>
        challenge.id === input.challengeId &&
        challenge.companyId === input.companyId &&
        challenge.userId === input.userId,
    );
    const wasActive = current?.consumedAt === null;
    this.store.passwordChallenges = this.store.passwordChallenges.filter(
      (challenge) => challenge.id !== input.challengeId,
    );
    if (!wasActive) return;

    const previous = this.store.passwordChallenges
      .filter(
        (challenge) =>
          challenge.companyId === input.companyId &&
          challenge.userId === input.userId &&
          challenge.consumedAt?.getTime() === input.replacedAt.getTime() &&
          challenge.expiresAt > new Date(),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (previous) previous.consumedAt = null;
  }

  async findById(id: string) {
    return (
      this.store.passwordChallenges.find((challenge) => challenge.id === id) ??
      null
    );
  }

  async complete(input: CompletePasswordChangePersistenceInput) {
    const challenge = this.store.passwordChallenges.find(
      (candidate) =>
        candidate.id === input.challengeId &&
        candidate.companyId === input.companyId &&
        candidate.userId === input.userId &&
        candidate.consumedAt === null &&
        candidate.expiresAt > input.changedAt,
    );
    const userIndex = this.store.users.findIndex(
      (candidate) =>
        candidate.companyId === input.companyId &&
        candidate.id === input.userId,
    );
    const user = this.store.users[userIndex];
    if (
      !challenge ||
      !user ||
      (challenge.reason === 'first-access' && !user.props.mustChangePassword)
    ) {
      return false;
    }

    this.store.passwordHistory.push({
      companyId: input.companyId,
      userId: input.userId,
      passwordHash: user.props.passwordHash,
      createdAt: input.changedAt,
    });
    this.store.users[userIndex] = User.restore({
      ...user.props,
      passwordHash: input.passwordHash,
      mustChangePassword: false,
      tokenVersion: user.props.tokenVersion + 1,
      updatedAt: input.changedAt,
    });
    challenge.consumedAt = input.changedAt;
    for (const current of this.store.passwordChallenges) {
      if (
        current.id !== input.challengeId &&
        current.companyId === input.companyId &&
        current.userId === input.userId &&
        current.consumedAt === null
      ) {
        current.consumedAt = input.changedAt;
      }
    }
    for (const token of this.store.refreshTokens) {
      if (
        token.companyId === input.companyId &&
        token.userId === input.userId &&
        token.revokedAt === null
      ) {
        token.revokedAt = input.changedAt;
      }
    }
    return true;
  }

  async delete(id: string) {
    this.store.passwordChallenges = this.store.passwordChallenges.filter(
      (challenge) => challenge.id !== id,
    );
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

export class FakePasswordChangeTokenService extends PasswordChangeTokenService {
  private readonly delegate = new FakeRefreshTokenService();

  issue() {
    return this.delegate.issue();
  }

  parse(token: string) {
    return this.delegate.parse(token);
  }

  matches(firstHash: string, secondHash: string) {
    return this.delegate.matches(firstHash, secondHash);
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
        features: ['users'],
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
        graceUntil: '2030-02-01T00:00:00.000Z',
      },
    };
  }
}
