import type { UserOutput } from '../../presenters/user.presenter';

export interface AuthenticatedSessionOutput {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  session: {
    version: 1;
    id: string;
    user: UserOutput;
    issuedAt: string;
    expiresAt: string;
    rememberDevice: boolean;
  };
}

export type AuthenticationOutput = AuthenticatedSessionOutput;
