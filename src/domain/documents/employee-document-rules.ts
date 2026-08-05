import type {
  MaritalStatus,
  MilitaryDocumentStatus,
  UserDependent,
} from '../entities/user';

export interface EmployeeDocumentProfile {
  readonly jobTitle: string | null;
  readonly maritalStatus: MaritalStatus | null;
  readonly militaryDocumentStatus: MilitaryDocumentStatus;
  readonly dependents: readonly UserDependent[];
}

export interface EmployeeDocumentRuleContext {
  readonly hasSpouse: boolean;
  readonly dependentCount: number;
  readonly hasDependentUnder7: boolean;
  readonly hasDependentSchoolAge: boolean;
  readonly militaryDocumentStatus: MilitaryDocumentStatus;
  readonly isDriver: boolean;
}

function ageAt(date: Date, reference: Date): number {
  let age = reference.getUTCFullYear() - date.getUTCFullYear();
  const beforeBirthday =
    reference.getUTCMonth() < date.getUTCMonth() ||
    (reference.getUTCMonth() === date.getUTCMonth() &&
      reference.getUTCDate() < date.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function employeeDocumentRuleContext(
  profile: EmployeeDocumentProfile,
  reference = new Date(),
): EmployeeDocumentRuleContext {
  const ages = profile.dependents
    .map((dependent) => new Date(`${dependent.birthDate}T00:00:00.000Z`))
    .filter((date) => !Number.isNaN(date.getTime()))
    .map((date) => ageAt(date, reference));
  const normalizedTitle = profile.jobTitle
    ?.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return {
    hasSpouse: ['married', 'stable-union'].includes(
      profile.maritalStatus ?? '',
    ),
    dependentCount: profile.dependents.length,
    hasDependentUnder7: ages.some((age) => age >= 0 && age < 7),
    hasDependentSchoolAge: ages.some((age) => age > 7 && age <= 16),
    militaryDocumentStatus: profile.militaryDocumentStatus,
    isDriver: Boolean(normalizedTitle?.includes('motorista')),
  };
}

export function matchesEmployeeDocumentCondition(
  condition: Readonly<Record<string, unknown>>,
  context: EmployeeDocumentRuleContext,
): boolean {
  if (Object.keys(condition).length === 0) return true;
  const field = condition.field;
  const operator = condition.operator;
  if (typeof field !== 'string' || typeof operator !== 'string') return false;
  const actual = context[field as keyof EmployeeDocumentRuleContext];
  if (operator === 'equals') return actual === condition.value;
  if (operator === 'in' && Array.isArray(condition.value)) {
    return condition.value.includes(actual);
  }
  if (operator === 'greater-than') {
    return typeof actual === 'number' && actual > Number(condition.value);
  }
  return false;
}
