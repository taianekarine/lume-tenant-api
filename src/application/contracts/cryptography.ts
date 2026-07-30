export interface AccessTokenPayload {
  sub: string;
  companyId: string;
  tokenVersion: number;
}

export interface OfflineLicensePayload {
  version: 1;
  licenseId: string;
  installationId: string;
  tenantId: string;
  plan: string;
  features: string[];
  issuedAt: string;
  expiresAt: string;
  graceUntil: string;
}

export interface OfflineLicenseStatus {
  state: 'active' | 'grace';
  payload: OfflineLicensePayload;
}

export abstract class PasswordHasher {
  abstract hash(plainText: string): Promise<string>;
  abstract compare(plainText: string, hash: string): Promise<boolean>;
}

export abstract class AccessTokenService {
  abstract readonly expiresInSeconds: number;
  abstract sign(payload: AccessTokenPayload): Promise<string>;
  abstract verify(token: string): Promise<AccessTokenPayload>;
}

export interface IssuedRefreshToken {
  id: string;
  plainText: string;
  hash: string;
}

export interface ParsedRefreshToken {
  id: string;
  hash: string;
}

export abstract class RefreshTokenService {
  abstract issue(): IssuedRefreshToken;
  abstract parse(token: string): ParsedRefreshToken | null;
  abstract matches(firstHash: string, secondHash: string): boolean;
}

export abstract class PasswordChangeTokenService extends RefreshTokenService {}

export abstract class OfflineLicenseVerifier {
  abstract status(at?: Date): OfflineLicenseStatus;
}
