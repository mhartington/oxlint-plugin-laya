import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    // `sync-jev` is packed so the worker test can drive the built copy, which is the only place
    // where its `./worker.mjs` URL resolves. It is shipped but deliberately not an export.
    entry: ['src/index.ts', 'src/worker.ts', 'src/sync-jev.ts'],
    platform: 'node',
    deps: { resolveDepSubpath: true },
    dts: {
      generator: 'tsgo',
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    singleQuote: true,
    semi: true,
  },
  test: {
    // The end-to-end tests share one cache directory under node_modules/.cache.
    fileParallelism: false,
    testTimeout: 120000,
  },
});
