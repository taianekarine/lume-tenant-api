import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { normalizedRequestRoute } from './api-usage.interceptor';

describe('normalizedRequestRoute', () => {
  it('keeps the route template and never stores query parameters or identifiers', () => {
    const request = {
      baseUrl: '/api/v1',
      path: '/users/00000000-0000-4000-8000-000000000001',
      route: { path: '/users/:id' },
    } as unknown as Request;

    expect(normalizedRequestRoute(request)).toBe('/users/:id');
  });

  it('redacts identifiers when Express has no route template', () => {
    const request = {
      baseUrl: '',
      path: '/documents/00000000-0000-4000-8000-000000000001/files/42',
    } as Request;

    expect(normalizedRequestRoute(request)).toBe('/documents/:id/files/:id');
  });
});
