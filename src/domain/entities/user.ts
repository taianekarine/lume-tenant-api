import { randomUUID } from 'node:crypto';

import type { Department } from '../access/access.constants';

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
  departments: Department[];
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
      | 'createdAt'
      | 'updatedAt'
    >,
  ): User {
    const now = new Date();

    return new User({
      ...input,
      id: randomUUID(),
      isActive: true,
      tokenVersion: 1,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: UserProps): User {
    return new User(props);
  }

  get id(): string {
    return this.props.id;
  }

  get companyId(): string {
    return this.props.companyId;
  }
}
