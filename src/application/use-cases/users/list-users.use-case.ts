import {
  UsersRepository,
  type UserListQuery,
} from '../../contracts/repositories';
import { presentUser } from '../../presenters/user.presenter';

export class ListUsersUseCase {
  constructor(private readonly users: UsersRepository) {}

  async execute(companyId: string, query: UserListQuery) {
    const result = await this.users.list(companyId, query);

    return {
      data: result.items.map(presentUser),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / query.pageSize),
      },
    };
  }
}
