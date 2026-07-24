import { createPublicKey, verify } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  OfflineLicenseVerifier,
  type OfflineLicensePayload,
  type OfflineLicenseStatus,
} from '../../application/contracts/cryptography';
import { licenseUnavailable } from '../../core/errors/app-error';

function isPayload(value: unknown): value is OfflineLicensePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.version === 1 &&
    typeof payload.licenseId === 'string' &&
    typeof payload.installationId === 'string' &&
    typeof payload.tenantId === 'string' &&
    typeof payload.plan === 'string' &&
    Array.isArray(payload.features) &&
    payload.features.every((feature) => typeof feature === 'string') &&
    typeof payload.issuedAt === 'string' &&
    typeof payload.expiresAt === 'string' &&
    typeof payload.graceUntil === 'string'
  );
}

@Injectable()
export class Ed25519OfflineLicenseVerifier implements OfflineLicenseVerifier {
  private readonly payload: OfflineLicensePayload;

  constructor(config: ConfigService) {
    const installationId = config.getOrThrow<string>('INSTALLATION_ID');
    const publicKeyPem = Buffer.from(
      config.getOrThrow<string>('LICENSE_PUBLIC_KEY_BASE64'),
      'base64',
    ).toString('utf8');
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(
        'LICENSE_PUBLIC_KEY_BASE64 deve conter uma chave Ed25519.',
      );
    }
    const document = config.getOrThrow<string>('LICENSE_DOCUMENT');
    const [encodedPayload, encodedSignature, extra] = document.split('.');
    if (!encodedPayload || !encodedSignature || extra) {
      throw new Error('LICENSE_DOCUMENT possui formato inválido.');
    }
    const valid = verify(
      null,
      Buffer.from(encodedPayload, 'utf8'),
      publicKey,
      Buffer.from(encodedSignature, 'base64url'),
    );
    if (!valid) throw new Error('A assinatura da licença é inválida.');
    const decoded: unknown = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    );
    if (!isPayload(decoded)) {
      throw new Error('O conteúdo da licença é inválido.');
    }
    if (decoded.installationId !== installationId) {
      throw new Error('A licença pertence a outra instalação.');
    }
    if (
      !Number.isFinite(Date.parse(decoded.expiresAt)) ||
      !Number.isFinite(Date.parse(decoded.graceUntil))
    ) {
      throw new Error('As datas da licença são inválidas.');
    }
    this.payload = decoded;
  }

  status(at = new Date()): OfflineLicenseStatus {
    if (at <= new Date(this.payload.expiresAt)) {
      return { state: 'active', payload: this.payload };
    }
    if (at <= new Date(this.payload.graceUntil)) {
      return { state: 'grace', payload: this.payload };
    }
    throw licenseUnavailable(
      'A licença local e o período de tolerância expiraram.',
    );
  }
}
