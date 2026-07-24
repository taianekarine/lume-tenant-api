import { Injectable } from '@nestjs/common';

import {
  RefreshTokensRepository,
  type RefreshTokenRecord,
} from '../../../application/contracts/repositories';
import { AppError } from '../../../core/errors/app-error';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaRefreshTokensRepository extends RefreshTokensRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(token: RefreshTokenRecord): Promise<void> {
    await this.prisma.refreshToken.create({ data: token });
  }

  async findById(id: string): Promise<RefreshTokenRecord | null> {
    return this.prisma.refreshToken.findUnique({ where: { id } });
  }

  async rotate(
    currentId: string,
    nextToken: RefreshTokenRecord,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.refreshToken.updateMany({
        where: { id: currentId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      if (result.count !== 1) {
        throw new AppError(
          'INVALID_REFRESH_TOKEN',
          'Sessão inválida ou expirada.',
        );
      }

      await transaction.refreshToken.create({ data: nextToken });
    });
  }

  async revoke(id: string, revokedAt: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt },
    });
  }

  async revokeAllForUser(
    companyId: string,
    userId: string,
    revokedAt: Date,
  ): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { companyId, userId, revokedAt: null },
      data: { revokedAt },
    });
  }
}
