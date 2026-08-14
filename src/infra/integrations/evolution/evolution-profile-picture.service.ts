import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 3_600_000;
const EMPTY_CACHE_TTL_MS = 300_000;

type CachedProfilePicture = Readonly<{
  expiresAt: number;
  url?: string;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function safePictureUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1_000) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function extractEvolutionProfilePictureUrl(
  value: unknown,
): string | undefined {
  const response = asRecord(value);
  if (!response) return undefined;
  const nested = asRecord(response.data) ?? asRecord(response.response);
  return (
    safePictureUrl(response.profilePictureUrl) ??
    safePictureUrl(response.profilePicUrl) ??
    safePictureUrl(response.picture) ??
    safePictureUrl(nested?.profilePictureUrl) ??
    safePictureUrl(nested?.profilePicUrl) ??
    safePictureUrl(nested?.picture)
  );
}

@Injectable()
export class EvolutionProfilePictureService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CachedProfilePicture>();

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('EVOLUTION_BASE_URL') ?? '')
      .trim()
      .replace(/\/+$/, '');
    this.apiKey = (config.get<string>('EVOLUTION_API_KEY') ?? '').trim();
    this.timeoutMs = Math.max(
      1_000,
      config.get<number>('EVOLUTION_PROFILE_PICTURE_TIMEOUT_MS') ??
        DEFAULT_TIMEOUT_MS,
    );
    this.cacheTtlMs = Math.max(
      60_000,
      config.get<number>('EVOLUTION_PROFILE_PICTURE_CACHE_TTL_MS') ??
        DEFAULT_CACHE_TTL_MS,
    );
  }

  async get(instanceName: string, phone: string): Promise<string | undefined> {
    if (
      !this.baseUrl ||
      !this.apiKey ||
      !instanceName.trim() ||
      !/^\d{10,15}$/.test(phone)
    ) {
      return undefined;
    }

    const cacheKey = `${instanceName}:${phone}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.url;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(
        `${this.baseUrl}/chat/fetchProfilePictureUrl/${encodeURIComponent(instanceName)}`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            apikey: this.apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ number: phone }),
          signal: controller.signal,
        },
      );
      const url = response.ok
        ? extractEvolutionProfilePictureUrl(
            await response.json().catch(() => null),
          )
        : undefined;
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + (url ? this.cacheTtlMs : EMPTY_CACHE_TTL_MS),
        ...(url ? { url } : {}),
      });
      return url;
    } catch {
      this.cache.set(cacheKey, { expiresAt: Date.now() + EMPTY_CACHE_TTL_MS });
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}
