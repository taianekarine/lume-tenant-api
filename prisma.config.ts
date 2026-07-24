import 'dotenv/config';

import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://lume:lume@localhost:5433/lume_tenant?schema=public',
  },
});
