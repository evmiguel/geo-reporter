import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  // Without this, Vite reads .env from the `root` directory (src/web/) —
  // but the project's single .env lives at the repo root alongside
  // package.json. Point envDir there so VITE_* vars resolve.
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/grades': { target: 'http://localhost:7777', changeOrigin: true },
      '/healthz': { target: 'http://localhost:7777', changeOrigin: true },
      '/auth': { target: 'http://localhost:7777', changeOrigin: true },
      '/billing': { target: 'http://localhost:7777', changeOrigin: true },
      '/report': { target: 'http://localhost:7777', changeOrigin: true },
    },
  },
})
