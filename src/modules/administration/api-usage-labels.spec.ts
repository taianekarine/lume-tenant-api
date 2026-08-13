import { describe, expect, it } from 'vitest';

import { humanizeApiAction } from './api-usage-labels';

describe('humanizeApiAction', () => {
  it('presents common actions without exposing the technical route', () => {
    expect(
      humanizeApiAction(
        'POST',
        '/document-management/items/:requestItemId/submissions/complete',
      ),
    ).toBe('Enviar documento para análise');
    expect(humanizeApiAction('DELETE', '/users/:id')).toBe('Excluir usuário');
  });

  it('uses a safe generic label for an unknown route', () => {
    expect(humanizeApiAction('GET', '/internal/example')).toBe(
      'Consultar recurso da plataforma',
    );
  });
});
