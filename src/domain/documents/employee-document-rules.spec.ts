import { describe, expect, it } from 'vitest';

import {
  employeeDocumentRuleContext,
  eligibleDependentsForDocument,
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

  it('separa os dependentes elegíveis sem criar um item duplicado por filho', () => {
    const dependents = [
      {
        name: 'Criança pequena',
        birthDate: '2021-08-06',
        relationship: 'filho(a)',
      },
      {
        name: 'Criança escolar',
        birthDate: '2014-08-05',
        relationship: 'filho(a)',
      },
      {
        name: 'Dependente adulto',
        birthDate: '2000-01-01',
        relationship: 'filho(a)',
      },
    ];
    const reference = new Date('2026-08-05T12:00:00.000Z');

    expect(
      eligibleDependentsForDocument(
        'child-vaccination-card',
        dependents,
        reference,
      ),
    ).toHaveLength(1);
    expect(
      eligibleDependentsForDocument(
        'child-school-statement',
        dependents,
        reference,
      ),
    ).toHaveLength(1);
    expect(
      eligibleDependentsForDocument(
        'child-identification',
        dependents,
        reference,
      ),
    ).toHaveLength(3);
  });
});
