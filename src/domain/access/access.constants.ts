export const ASSIGNABLE_DEPARTMENTS = [
  'client-company',
  'commercial',
  'purchasing',
  'controllership',
  'personnel-department',
  'financial',
  'management',
  'maintenance',
  'monitoring',
  'operations',
  'information-technology',
] as const;

export type AssignableDepartment = (typeof ASSIGNABLE_DEPARTMENTS)[number];

export const ASSIGNABLE_DEPARTMENT_LABELS: Readonly<
  Record<AssignableDepartment, string>
> = {
  'client-company': 'Empresa cliente',
  commercial: 'Comercial',
  purchasing: 'Compras',
  controllership: 'Controladoria',
  'personnel-department': 'Departamento Pessoal',
  financial: 'Financeiro',
  management: 'Gerência',
  maintenance: 'Manutenção',
  monitoring: 'Monitoramento',
  operations: 'Operacional',
  'information-technology': 'Tecnologia da Informação (TI)',
};

export const LEGACY_DEPARTMENTS = [
  'human-resources',
  'controlling',
  'cleaning',
] as const;

export const DEPARTMENTS = [
  'client-company',
  'human-resources',
  'personnel-department',
  'commercial',
  'purchasing',
  'controlling',
  'maintenance',
  'monitoring',
  'management',
  'operations',
  'cleaning',
  'financial',
  'information-technology',
] as const;

export type Department = (typeof DEPARTMENTS)[number];

export const SUPPORTED_USER_DEPARTMENTS = [
  ...ASSIGNABLE_DEPARTMENTS,
  ...LEGACY_DEPARTMENTS,
] as const;

export type SupportedUserDepartment =
  (typeof SUPPORTED_USER_DEPARTMENTS)[number];
export type UserDepartment = Department;
export type PresentedUserDepartment =
  Exclude<UserDepartment, 'controlling'> | 'controllership';

export function normalizeUserDepartment(
  department: SupportedUserDepartment,
): UserDepartment {
  return department === 'controllership' ? 'controlling' : department;
}

export function normalizeUserDepartments(
  departments: readonly SupportedUserDepartment[],
): UserDepartment[] {
  return Array.from(new Set(departments.map(normalizeUserDepartment)));
}

export function presentUserDepartment(
  department: UserDepartment,
): PresentedUserDepartment {
  return department === 'controlling' ? 'controllership' : department;
}

export const PERMISSION_RESOURCES = [
  'dashboard',
  'users',
  'human-resources',
  'personnel-department',
  'commercial',
  'purchasing',
  'maintenance',
  'monitoring',
  'operations',
  'cleaning',
  'drivers',
  'financial',
  'clients',
  'ai-agents',
  'whatsapp-conversations',
  'manuals',
  'reports',
  'settings',
  'license',
  'profile',
  'contracts',
  'quotes',
  'trips',
  'documents',
  'invoices',
  'service-requests',
  'routing-companies',
  'routing-contracts',
  'passengers',
  'routes',
  'support',
] as const;

export const PERMISSION_ACTIONS = [
  'view',
  'create',
  'update',
  'delete',
  'manage',
  'use',
  'approve',
  'export',
  'import',
  'publish',
] as const;

export type PermissionResource = (typeof PERMISSION_RESOURCES)[number];
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const PERMISSION_ACTIONS_BY_RESOURCE = {
  dashboard: ['view'],
  users: ['view', 'create', 'update', 'manage'],
  'human-resources': ['view', 'create', 'update', 'delete', 'manage'],
  'personnel-department': ['view', 'create', 'update', 'delete', 'manage'],
  commercial: ['view', 'create', 'update', 'delete', 'manage'],
  purchasing: ['view', 'create', 'update', 'delete', 'manage'],
  maintenance: ['view', 'create', 'update', 'delete', 'manage'],
  monitoring: ['view', 'create', 'update', 'delete', 'manage'],
  operations: ['view', 'create', 'update', 'delete', 'manage'],
  cleaning: ['view', 'create', 'update', 'delete', 'manage'],
  drivers: ['view', 'create', 'update', 'delete', 'manage'],
  financial: [
    'view',
    'create',
    'update',
    'delete',
    'manage',
    'approve',
    'export',
  ],
  clients: ['view', 'create', 'update', 'delete', 'manage'],
  'ai-agents': ['view', 'create', 'update', 'delete', 'manage', 'use'],
  'whatsapp-conversations': ['view', 'manage'],
  manuals: ['view', 'create', 'update', 'delete', 'manage'],
  reports: ['view', 'create', 'update', 'delete', 'manage', 'export'],
  settings: ['view', 'update', 'manage'],
  license: ['view'],
  profile: ['view', 'update'],
  contracts: ['view', 'create', 'update', 'delete', 'manage'],
  quotes: ['view', 'create', 'update', 'delete', 'manage', 'approve'],
  trips: ['view', 'create', 'update', 'delete', 'manage'],
  documents: [
    'view',
    'create',
    'update',
    'delete',
    'manage',
    'approve',
    'export',
  ],
  invoices: ['view', 'create', 'update', 'delete', 'manage'],
  'service-requests': ['view', 'create', 'update', 'manage'],
  'routing-companies': ['view', 'create', 'update', 'manage'],
  'routing-contracts': [
    'view',
    'create',
    'update',
    'manage',
    'approve',
    'export',
  ],
  passengers: ['view', 'create', 'update', 'manage', 'import', 'export'],
  routes: [
    'view',
    'create',
    'update',
    'manage',
    'use',
    'approve',
    'export',
    'publish',
  ],
  support: ['view', 'create', 'update', 'manage'],
} as const satisfies Record<PermissionResource, readonly PermissionAction[]>;

export type PermissionCode = {
  [
    Resource in PermissionResource
  ]: `${Resource}:${(typeof PERMISSION_ACTIONS_BY_RESOURCE)[Resource][number]}`;
}[PermissionResource];

export const EMPLOYEE_SELF_SERVICE_PERMISSIONS = [
  'dashboard:view',
  'ai-agents:use',
  'profile:view',
  'profile:update',
  'support:view',
  'support:create',
  'documents:view',
  'documents:create',
  'documents:update',
] as const satisfies readonly PermissionCode[];

export const MANAGEMENT_DEPARTMENT_PERMISSIONS = [
  'dashboard:view',
  'ai-agents:use',
  'manuals:view',
  'manuals:create',
  'manuals:update',
  'manuals:delete',
  'manuals:manage',
  'reports:view',
  'reports:export',
  'settings:view',
  'settings:update',
  'settings:manage',
  'license:view',
  'profile:view',
  'profile:update',
  'support:view',
  'support:create',
  'documents:view',
  'documents:create',
  'documents:update',
  'documents:manage',
  'documents:approve',
  'documents:export',
  'routing-companies:view',
  'routing-companies:create',
  'routing-companies:update',
  'routing-companies:manage',
  'routing-contracts:view',
  'routing-contracts:create',
  'routing-contracts:update',
  'routing-contracts:manage',
  'routing-contracts:approve',
  'routing-contracts:export',
  'passengers:view',
  'passengers:import',
  'passengers:export',
  'routes:view',
  'routes:update',
  'routes:approve',
  'routes:export',
  'routes:publish',
] as const satisfies readonly PermissionCode[];

export const ALL_PERMISSION_CODES: readonly PermissionCode[] =
  PERMISSION_RESOURCES.flatMap((resource) =>
    PERMISSION_ACTIONS_BY_RESOURCE[resource].map(
      (action) => `${resource}:${action}` as PermissionCode,
    ),
  );

const permissionCodeSet = new Set<string>(ALL_PERMISSION_CODES);

export function isPermissionCode(value: string): value is PermissionCode {
  return permissionCodeSet.has(value);
}

export const DEFAULT_DEPARTMENT_PERMISSIONS: Readonly<
  Record<SupportedUserDepartment, readonly PermissionCode[]>
> = {
  'client-company': [
    'dashboard:view',
    'routing-companies:view',
    'routing-contracts:view',
    'passengers:view',
    'passengers:create',
    'passengers:update',
    'passengers:import',
    'passengers:export',
    'routes:view',
    'support:view',
    'support:create',
    'profile:view',
    'profile:update',
  ],
  'human-resources': [
    'dashboard:view',
    'users:view',
    'users:create',
    'human-resources:view',
    'human-resources:create',
    'human-resources:update',
    'human-resources:manage',
    'manuals:view',
    'ai-agents:use',
    'reports:view',
    'users:view',
    'users:create',
    'documents:view',
    'documents:create',
    'documents:update',
    'documents:manage',
    'documents:approve',
    'documents:export',
    'routing-companies:view',
    'routing-contracts:view',
    'passengers:view',
    'passengers:create',
    'passengers:update',
    'passengers:import',
  ],
  'personnel-department': [
    'dashboard:view',
    'personnel-department:view',
    'personnel-department:create',
    'personnel-department:update',
    'personnel-department:manage',
    'manuals:view',
    'reports:view',
    'reports:export',
    'users:view',
    'users:create',
    'documents:view',
    'documents:create',
    'documents:update',
    'documents:manage',
    'documents:approve',
    'documents:export',
    'routing-companies:view',
    'routing-contracts:view',
    'passengers:view',
    'passengers:create',
    'passengers:update',
    'passengers:import',
  ],
  commercial: [
    'dashboard:view',
    'commercial:view',
    'commercial:create',
    'commercial:update',
    'commercial:manage',
    'clients:view',
    'clients:create',
    'clients:update',
    'whatsapp-conversations:manage',
    'ai-agents:use',
    'manuals:view',
    'reports:view',
    'reports:export',
    'routing-companies:view',
    'routing-contracts:view',
    'routing-contracts:create',
    'routing-contracts:update',
    'routing-contracts:manage',
    'routing-contracts:export',
  ],
  purchasing: [
    'dashboard:view',
    'purchasing:view',
    'purchasing:create',
    'purchasing:update',
    'purchasing:manage',
    'manuals:view',
    'reports:view',
    'reports:export',
  ],
  controlling: [
    'dashboard:view',
    'financial:view',
    'financial:create',
    'financial:update',
    'financial:manage',
    'financial:approve',
    'financial:export',
    'commercial:view',
    'clients:view',
    'manuals:view',
    'reports:view',
    'reports:export',
    'routing-companies:view',
    'routing-contracts:view',
    'routing-contracts:export',
    'passengers:view',
    'passengers:export',
    'routes:view',
    'routes:export',
  ],
  controllership: [
    'dashboard:view',
    'financial:view',
    'financial:create',
    'financial:update',
    'financial:manage',
    'financial:approve',
    'financial:export',
    'commercial:view',
    'clients:view',
    'manuals:view',
    'reports:view',
    'reports:export',
    'routing-companies:view',
    'routing-contracts:view',
    'routing-contracts:export',
    'passengers:view',
    'passengers:export',
    'routes:view',
    'routes:export',
  ],
  maintenance: [
    'dashboard:view',
    'maintenance:view',
    'maintenance:create',
    'maintenance:update',
    'maintenance:manage',
    'operations:view',
    'drivers:view',
    'manuals:view',
    'reports:view',
  ],
  monitoring: [
    'dashboard:view',
    'monitoring:view',
    'monitoring:create',
    'monitoring:update',
    'monitoring:manage',
    'operations:view',
    'drivers:view',
    'manuals:view',
    'reports:view',
    'reports:export',
  ],
  management: MANAGEMENT_DEPARTMENT_PERMISSIONS,
  operations: [
    'dashboard:view',
    'operations:view',
    'operations:create',
    'operations:update',
    'operations:manage',
    'monitoring:view',
    'maintenance:view',
    'cleaning:view',
    'drivers:view',
    'drivers:manage',
    'ai-agents:use',
    'manuals:view',
    'reports:view',
    'reports:export',
    'routing-companies:view',
    'routing-companies:create',
    'routing-companies:update',
    'routing-contracts:view',
    'routing-contracts:export',
    'passengers:view',
    'passengers:create',
    'passengers:update',
    'passengers:manage',
    'passengers:import',
    'passengers:export',
    'routes:view',
    'routes:create',
    'routes:update',
    'routes:manage',
    'routes:use',
    'routes:approve',
    'routes:export',
    'routes:publish',
  ],
  cleaning: [
    'dashboard:view',
    'cleaning:view',
    'cleaning:update',
    'operations:view',
    'manuals:view',
  ],
  financial: [
    'dashboard:view',
    'financial:view',
    'financial:create',
    'financial:update',
    'financial:manage',
    'financial:approve',
    'financial:export',
    'commercial:view',
    'clients:view',
    'manuals:view',
    'reports:view',
    'reports:export',
    'routing-companies:view',
    'routing-companies:update',
    'routing-contracts:view',
    'routing-contracts:export',
    'passengers:view',
    'passengers:export',
    'routes:view',
    'routes:export',
  ],
  'information-technology': [
    'dashboard:view',
    'ai-agents:view',
    'ai-agents:create',
    'ai-agents:update',
    'ai-agents:delete',
    'ai-agents:manage',
    'ai-agents:use',
    'manuals:view',
    'manuals:create',
    'manuals:update',
    'manuals:delete',
    'manuals:manage',
    'reports:view',
    'reports:export',
    'users:view',
    'users:create',
    'users:update',
    'users:manage',
    'routing-companies:view',
    'routing-companies:create',
    'routing-companies:update',
    'routing-companies:manage',
    'routing-contracts:view',
    'routing-contracts:create',
    'routing-contracts:update',
    'routing-contracts:manage',
    'routing-contracts:approve',
    'routing-contracts:export',
    'passengers:view',
    'passengers:create',
    'passengers:update',
    'passengers:manage',
    'passengers:import',
    'passengers:export',
    'routes:view',
    'routes:create',
    'routes:update',
    'routes:manage',
    'routes:use',
    'routes:approve',
    'routes:export',
    'routes:publish',
  ],
};

export function allowedPermissionsForDepartments(
  departments: readonly SupportedUserDepartment[],
): PermissionCode[] {
  const allowed = new Set<PermissionCode>(EMPLOYEE_SELF_SERVICE_PERMISSIONS);

  for (const department of departments) {
    for (const permission of DEFAULT_DEPARTMENT_PERMISSIONS[department]) {
      allowed.add(permission);
    }
  }

  return Array.from(allowed).sort();
}

const implicitPermissionCodeSet = new Set<PermissionCode>(
  EMPLOYEE_SELF_SERVICE_PERMISSIONS,
);

export function isImplicitPermissionCode(permission: PermissionCode): boolean {
  return implicitPermissionCodeSet.has(permission);
}

export function departmentsAllowingPermission(
  permission: PermissionCode,
): UserDepartment[] {
  if (isImplicitPermissionCode(permission)) {
    return [...DEPARTMENTS];
  }

  return DEPARTMENTS.filter((department) =>
    DEFAULT_DEPARTMENT_PERMISSIONS[department].includes(permission),
  );
}
