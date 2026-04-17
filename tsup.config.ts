import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    server: 'src/server/server.ts',
    worker: 'src/worker/worker.ts',
  },
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false,
  minify: false,
})
