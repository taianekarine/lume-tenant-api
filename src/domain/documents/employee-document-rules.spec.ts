import { describe, expect, it } from 'vitest';

import {
  employeeDocumentRuleContext,
  matchesEmployeeDocumentCondition,
} from './employee-document-rules';

describe('employeeDocumentRuleContext', () => {
  it('combina regras de cônjuge e múltiplos dependentes por idade', () => {
    const context = employeeDocumentRuleContext(
      {
        jobTitle: 'Assistente administrativo',
        maritalStatus: 'married',
        militaryDocumentStatus: 'pending-confirmation',
        dependents: [
          { name: 'Criança A', birthDate: '2021-08-06' },
          { name: 'Criança B', birthDate: '2014-08-05' },
          { name: 'Dependente C', birthDate: '2006-01-01' },
        ],
      },
      new Date('2026-08-05T12:00:00.000Z'),
    );

    expect(context).toEqual({
      hasSpouse: true,
      dependentCount: 3,
      hasDependentUnder7: true,
      hasDependentSchoolAge: true,
      militaryDocumentStatus: 'pending-confirmation',
      isDriver: false,
    });
    expect(
      matchesEmployeeDocumentCondition(
        { field: 'dependentCount', operator: 'greater-than', value: 0 },
        context,
      ),
    ).toBe(true);
  });

  it('identifica motorista pelo cargo e não usa gênero para documento militar', () => {
    const context = employeeDocumentRuleContext({
      jobTitle: 'Motorista Rodoviário',
      maritalStatus: 'single',
      militaryDocumentStatus: 'not-applicable',
      dependents: [],
    });

    expect(context.isDriver).toBe(true);
    expect(context.militaryDocumentStatus).toBe('not-applicable');
  });
});
