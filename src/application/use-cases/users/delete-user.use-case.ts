import { conflict, forbidden, notFound } from '../../../core/errors/app-error';
import {
  TenantAuditLogsRepository,
  UsersRepository,
} from '../../contracts/repositories';

export class DeleteUserUseCase {
  constructor(
    private readonly users: UsersRepository,
    private readonly auditLogs?: TenantAuditLogsRepository,
  ) {}

  async execute(input: {
    companyId: string;
    actorUserId: string;
    userId: string;
  }): Promise<{ deleted: true }> {
    const actor = await this.users.findById(input.companyId, input.actorUserId);
    if (!actor?.user.props.isAdministrator) {
      throw forbidden('Somente administradores podem excluir usuários.');
    }
    if (input.actorUserId === input.userId) {
      throw forbidden('Você não pode excluir a própria conta.');
    }

    const target = await this.users.findById(input.companyId, input.userId);
    if (!target) throw notFound('Usuário');

    const deleted = await this.users.softDelete(
      input.companyId,
      input.userId,
      new Date(),
    );
    if (!deleted) {
      throw conflict('A empresa deve manter ao menos um administrador ativo.');
    }

    await this.auditLogs?.create({
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: 'USER_DELETED',
      targetType: 'user',
      targetId: input.userId,
      metadata: { wasAdministrator: target.user.props.isAdministrator },
    });
    return { deleted: true };
  }
}
