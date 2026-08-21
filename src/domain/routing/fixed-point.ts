import { randomUUID } from 'node:crypto';

import { validationError } from '../../core/errors/app-error';
import { normalizeRouteAddress, type RouteAddress } from './route';

export type RoutingFixedPointStatus = 'active' | 'inactive';

export interface RoutingFixedPointProps {
  id: string;
  companyId: string;
  routingCompanyId: string | null;
  code: string;
  name: string;
  status: RoutingFixedPointStatus;
  address: RouteAddress;
  version: number;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export function createRoutingFixedPoint(input: {
  companyId: string;
  routingCompanyId?: string | null;
  name: string;
  address: Omit<RouteAddress, 'label'> & { label?: string };
  actorUserId: string;
}): RoutingFixedPointProps {
  const id = randomUUID();
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 160) {
    throw validationError(
      'Informe um nome de ponto fixo entre 2 e 160 caracteres.',
    );
  }
  const now = new Date();
  return {
    id,
    companyId: input.companyId,
    routingCompanyId: input.routingCompanyId ?? null,
    code: `PF-${id.replaceAll('-', '').slice(0, 8).toUpperCase()}`,
    name,
    status: 'active',
    address: normalizeRouteAddress(
      { ...input.address, label: name },
      'o ponto fixo',
    ),
    version: 1,
    createdByUserId: input.actorUserId,
    createdAt: now,
    updatedAt: now,
  };
}
