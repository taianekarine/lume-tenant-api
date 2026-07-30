import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { parseCorsOrigins } from './infra/config/environment';
import { configureBodyParsers } from './shared/http/configure-body-parsers';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bodyParser: false,
  });
  const config = app.get(ConfigService);
  const swaggerEnabled = config.getOrThrow<boolean>('SWAGGER_ENABLED');
  const trustProxyHops = config.getOrThrow<number>('TRUST_PROXY_HOPS');
  const maximumBodyBytes = config.getOrThrow<number>(
    'HTTP_MAX_JSON_BODY_BYTES',
  );

  configureBodyParsers(app, maximumBodyBytes);
  app.use(
    helmet(swaggerEnabled ? { contentSecurityPolicy: false } : undefined),
  );
  if (trustProxyHops > 0) {
    const express = app.getHttpAdapter().getInstance();
    express.set('trust proxy', trustProxyHops);
  }
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      stopAtFirstError: false,
    }),
  );
  app.enableCors({
    origin: parseCorsOrigins(config.getOrThrow<string>('CORS_ORIGINS')),
    credentials: true,
  });
  app.enableShutdownHooks();

  if (swaggerEnabled) {
    const openApiConfig = new DocumentBuilder()
      .setTitle('Lume Tenant API')
      .setDescription(
        'Data plane autônomo de um único tenant, com autenticação, usuários, departamentos e permissões diretas.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: '<keyId>.<secret>',
          description:
            'Identidade de serviço n8n com segredo armazenado por hash.',
        },
        'serviceBearer',
      )
      .build();
    const document = SwaggerModule.createDocument(app, openApiConfig);
    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'docs/openapi.json',
    });
  }

  await app.listen(config.getOrThrow<number>('PORT'));
}
void bootstrap();
