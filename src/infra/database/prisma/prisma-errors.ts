import {
  conflict,
  externalServiceUnavailable,
  validationError,
} from '../../../core/errors/app-error';

export function rethrowKnownPrismaConflict(error: unknown): never {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  if (code === 'P2002') {
    throw conflict('Ja existe um registro com estes dados unicos.');
  }
  if (code === 'P2000') {
    throw validationError('Um dos campos excede o tamanho permitido.');
  }
  if (code === 'P2003') {
    throw conflict(
      'O registro informado esta vinculado a dados inexistentes ou protegidos.',
    );
  }
  if (code === 'P2004') {
    throw validationError(
      'Os dados informados violam uma regra de consistencia do cadastro.',
    );
  }
  if (code === 'P2021' || code === 'P2022') {
    throw externalServiceUnavailable(
      'O banco de dados da aplicacao esta desatualizado. Aplique as migrations antes de repetir a operacao.',
      { prismaCode: code },
    );
  }
  throw error;
}
