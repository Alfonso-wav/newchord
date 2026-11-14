import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Los workers (dictado, archivo local) importan módulos: tienen que ser ES.
  worker: { format: 'es' },
  // El worklet del dictado se carga por URL del propio origen (Trusted Types): nunca como data:.
  build: { assetsInlineLimit: (file: string) => (file.includes('worklets') ? false : undefined) },
  // Traen su .wasm al lado y lo buscan con import.meta.url: sin preempaquetar en desarrollo.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm', '@huggingface/transformers'] },
  server: {
    // assets/ (sprites compartidos con el panel) queda fuera de web/.
    fs: { allow: ['..'] },
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } },
  },
});
