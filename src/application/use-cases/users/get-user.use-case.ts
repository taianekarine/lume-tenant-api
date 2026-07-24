import { notFound } from '../../../core/errors/app-error';
import { UsersRepository } from '../../contracts/repositories';
import { presentUser } from '../../presenters/user.presenter';

export class GetUserUseCase {
  constructor(private readonly users: UsersRepository) {}

  async execute(companyId: string, userId: string) {
    const user = await this.users.findById(companyId, userId);

    if (!user) {
      throw notFound('Usuário');
    }

    return presentUser(user);
  }
}
