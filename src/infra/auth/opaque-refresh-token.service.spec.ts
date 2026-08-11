import { describe, expect, it } from 'vitest';

import { OpaquePasswordChangeTokenService } from './opaque-refresh-token.service';

describe('OpaquePasswordChangeTokenService', () => {
  it('preserves the complete token in a password-reset URL and validates its hash', () => {
    const service = new OpaquePasswordChangeTokenService();
    const issued = service.issue();
    const url = new URL('https://app.example.test/reset-password');
    url.searchParams.set('token', issued.plainText);

    const received = new URL(url.toString()).searchParams.get('token');
    expect(received).toBe(issued.plainText);

    const parsed = service.parse(received!);
    expect(parsed).toEqual({ id: issued.id, hash: issued.hash });
    expect(service.matches(parsed!.hash, issued.hash)).toBe(true);
  });
});
