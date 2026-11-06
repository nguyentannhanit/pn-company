import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/** Resolve workspace packages to their sources so tests cover the real files. */
const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      '@pn/shared': pkg('shared'),
      '@pn/events': pkg('events'),
      '@pn/llm': pkg('llm'),
      '@pn/permissions': pkg('permissions'),
      '@pn/secrets': pkg('secrets'),
      '@pn/sandbox': pkg('sandbox'),
      '@pn/database': pkg('database'),
      '@pn/agents': pkg('agents'),
      '@pn/orchestrator': pkg('orchestrator'),
      '@pn/github': pkg('github'),
    },
  },
});
