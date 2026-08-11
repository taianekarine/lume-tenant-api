import { Injectable } from '@nestjs/common';

import {
  PasswordChangeChallengesRepository,
  type CompletePasswordChangePersistenceInput,
  type PasswordChangeChallengeRecord,
} from '../../../application/contracts/repositories';
import { PasswordChangeReason } from '../prisma/generated/client';
import { PrismaService } from '../prisma/prisma.service';

const reasonToPrisma = {
  'first-access': PasswordChangeReason.FIRST_ACCESS,
  'admin-reset': PasswordChangeReason.ADMIN_RESET,
} as const;

class PasswordChangeCompletionConflict extends Error {}

@Injectable()
export class PrismaPasswordChangeChallengesRepository extends PasswordChangeChallengesRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(challenge: PasswordChangeChallengeRecord): Promise<void> {
    await this.prisma.passwordChangeChallenge.create({
      data: {
        ...challenge,
        reason: reasonToPrisma[challenge.reason],
      },
    });
  }

  async replaceForUser(
    challenge: PasswordChangeChallengeRecord,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (transaction) => {
        await transaction.passwordChangeChallenge.updateMany({
          where: {
            companyId: challenge.companyId,
            userId: challenge.userId,
            consumedAt: null,
          },
          data: { consumedAt: challenge.createdAt },
        });
        await transaction.passwordChangeChallenge.create({
          data: {
            ...challenge,
            reason: reasonToPrisma[challenge.reason],
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async delete(id: string): Promise<void> {
    await this.prisma.passwordChangeChallenge.deleteMany({
      where: { id },
    });
  }

  async cancelReplacement(input: {
    challengeId: string;
    companyId: string;
    userId: string;
    replacedAt: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const active = await transaction.passwordChangeChallenge.findFirst({
        where: {
          id: input.challengeId,
          companyId: input.companyId,
          userId: input.userId,
          consumedAt: null,
        },
        select: { id: true },
      });
      await transaction.passwordChangeChallenge.deleteMany({
        where: {
          id: input.challengeId,
          companyId: input.companyId,
          userId: input.userId,
        },
      });
      if (!active) return;

      const previous = await transaction.passwordChangeChallenge.findFirst({
        where: {
          companyId: input.companyId,
          userId: input.userId,
          consumedAt: input.replacedAt,
          expiresAt: { gt: new Date() },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (previous) {
        await transaction.passwordChangeChallenge.update({
          where: { id: previous.id },
          data: { consumedAt: null },
        });
      }
    });
  }

  async findById(id: string): Promise<PasswordChangeChallengeRecord | null> {
    const challenge = await this.prisma.passwordChangeChallenge.findUnique({
      where: { id },
    });

    if (!challenge) return null;

    return {
      ...challenge,
      reason:
        challenge.reason === PasswordChangeReason.FIRST_ACCESS
          ? 'first-access'
          : 'admin-reset',
    };
  }

  async complete(
    input: CompletePasswordChangePersistenceInput,
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const [challenge, user] = await Promise.all([
            transaction.passwordChangeChallenge.findFirst({
              where: {
                id: input.challengeId,
                companyId: input.companyId,
                userId: input.userId,
                consumedAt: null,
                expiresAt: { gt: input.changedAt },
              },
              select: { id: true, reason: true },
            }),
            transaction.user.findUnique({
              where: {
                id_companyId: {
                  id: input.userId,
                  companyId: input.companyId,
                },
              },
              select: {
                passwordHash: true,
                mustChangePassword: true,
              },
            }),
          ]);

          if (
            !challenge ||
            !user ||
            (challenge.reason === PasswordChangeReason.FIRST_ACCESS &&
              !user.mustChangePassword)
          ) {
            return false;
          }

          const updatedUser = await transaction.user.updateMany({
            where: {
              id: input.userId,
              companyId: input.companyId,
              ...(challenge.reason === PasswordChangeReason.FIRST_ACCESS
                ? { mustChangePassword: true }
                : {}),
            },
            data: {
              passwordHash: input.passwordHash,
              mustChangePassword: false,
              tokenVersion: { increment: 1 },
            },
          });
          if (updatedUser.count !== 1) {
            throw new PasswordChangeCompletionConflict();
          }

          const consumedChallenge =
            await transaction.passwordChangeChallenge.updateMany({
              where: {
                id: input.challengeId,
                companyId: input.companyId,
                userId: input.userId,
                consumedAt: null,
                expiresAt: { gt: input.changedAt },
              },
              data: { consumedAt: input.changedAt },
            });
          if (consumedChallenge.count !== 1) {
            throw new PasswordChangeCompletionConflict();
          }

          await transaction.userPasswordHistory.create({
            data: {
              companyId: input.companyId,
              userId: input.userId,
              passwordHash: user.passwordHash,
              createdAt: input.changedAt,
            },
          });
          await transaction.refreshToken.updateMany({
            where: {
              companyId: input.companyId,
              userId: input.userId,
              revokedAt: null,
            },
            data: { revokedAt: input.changedAt },
          });
          await transaction.passwordChangeChallenge.updateMany({
            where: {
              companyId: input.companyId,
              userId: input.userId,
              id: { not: input.challengeId },
              consumedAt: null,
            },
            data: { consumedAt: input.changedAt },
          });

          return true;
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (error instanceof PasswordChangeCompletionConflict) {
        return false;
      }
      throw error;
    }
  }
}
