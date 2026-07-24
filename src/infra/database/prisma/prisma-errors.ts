import { conflict } from '../../../core/errors/app-error';

export function rethrowKnownPrismaConflict(error: unknown): never {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  ) {
    throw conflict('Já existe um registro com estes dados únicos.');
  }

  throw error;
}
