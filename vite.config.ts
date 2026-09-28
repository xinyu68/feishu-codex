import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  plugins: [react()],
  build: { outDir: '../build/ui', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5175, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8790', '/health': 'http://127.0.0.1:8790' } }
});
