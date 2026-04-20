import { defineConfig } from 'tsup'
import { copyFileSync } from 'node:fs'

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
  onSuccess: async () => {
    // The report renderer loads this via `new URL('./report.css', import.meta.url)`.
    // Bundling replaces `import.meta.url` with the dist/ location, so the css must
    // sit next to the bundle at runtime. tsup does not auto-copy non-code assets.
    copyFileSync('src/report/report.css', 'dist/report.css')
  },
})
