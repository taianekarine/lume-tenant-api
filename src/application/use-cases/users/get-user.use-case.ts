import { notFound } from '../../../core/errors/app-error';
import { UsersRepository } from '../../contracts/repositories';
import { presentUser } from '../../presenters/user.presenter';
import { assertCanAccessUserTarget } from '../../../domain/access/user-management-policy';

export class GetUserUseCase {
  constructor(private readonly users: UsersRepository) {}

  async execute(input: {
    companyId: string;
    actorUserId?: string;
    userId: string;
  }) {
    const user = await this.users.findById(input.companyId, input.userId);

    if (!user) {
      throw notFound('Usuário');
    }

    if (input.actorUserId) {
      const actor = await this.users.findById(
        input.companyId,
        input.actorUserId,
      );
      if (!actor) throw notFound('Usuário responsável');
      assertCanAccessUserTarget(actor.user.props, user.user.props);
    }

    return presentUser(user);
  }
}
