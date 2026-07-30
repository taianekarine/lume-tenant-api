import type { NestExpressApplication } from '@nestjs/platform-express';

export function configureBodyParsers(
  app: NestExpressApplication,
  maximumBodyBytes: number,
): void {
  const limit = `${maximumBodyBytes}b`;
  app.useBodyParser('json', { limit });
  app.useBodyParser('urlencoded', {
    limit,
    extended: true,
  });
}
