import {
  conflict,
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import type { UserAccountStatus } from '../../../domain/entities/user';
import {
  TenantAuditLogsRepository,
  UsersRepository,
} from '../../contracts/repositories';
import { presentUser } from '../../presenters/user.presenter';

export interface UpdateUserStatusInput {
  companyId: string;
  actorUserId: string;
  currentUserId: string;
  userId: string;
  status: UserAccountStatus;
  suspendedUntil?: Date;
  suspensionReason?: string;
}

export class UpdateUserStatusUseCase {
  constructor(
    private readonly users: UsersRepository,
    private readonly auditLogs?: TenantAuditLogsRepository,
  ) {}

  async execute(input: UpdateUserStatusInput) {
    const target = await this.users.findById(input.companyId, input.userId);
    if (!target) throw notFound('Usuário');

    if (input.userId === input.currentUserId && input.status !== 'active') {
      throw forbidden('Você não pode desativar ou suspender a própria conta.');
    }

    if (target.user.props.isAdministrator) {
      const actor = await this.users.findById(
        input.companyId,
        input.actorUserId,
      );
      if (!actor?.user.props.isAdministrator) {
        throw forbidden(
          'Somente outro administrador pode alterar o status de um administrador.',
        );
      }
    }

    const now = new Date();
    const reason = input.suspensionReason?.trim() || null;
    const suspendedUntil = input.suspendedUntil ?? null;

    if (
      input.status === 'suspended' &&
      (!suspendedUntil || suspendedUntil <= now || !reason || reason.length < 3)
    ) {
      throw validationError(
        'A suspensão exige uma data futura e um motivo com ao menos 3 caracteres.',
      );
    }

    const persistenceInput = {
      status: input.status,
      suspendedUntil: input.status === 'suspended' ? suspendedUntil : null,
      suspensionReason: input.status === 'suspended' ? reason : null,
      changedAt: now,
    };
    const updated =
      input.status !== 'active' &&
      target.user.props.status === 'active' &&
      target.user.props.isAdministrator
        ? await this.users.updateStatusWithAdministratorInvariant(
            input.companyId,
            input.userId,
            persistenceInput,
          )
        : await this.users.updateStatus(
            input.companyId,
            input.userId,
            persistenceInput,
          );
    if (!updated) {
      throw conflict('A empresa deve manter ao menos um administrador ativo.');
    }

    await this.auditLogs?.create({
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: 'USER_STATUS_CHANGED',
      targetType: 'user',
      targetId: input.userId,
      metadata: {
        previousStatus: target.user.props.status,
        status: input.status,
        suspendedUntil:
          input.status === 'suspended' ? suspendedUntil?.toISOString() : null,
        suspensionReason: input.status === 'suspended' ? reason : null,
      },
    });

    return presentUser(updated);
  }
}
