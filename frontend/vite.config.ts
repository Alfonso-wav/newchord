import { defineConfig } from 'vite';

// assets/ (sprites compartidos con la web) queda fuera de frontend/.
export default defineConfig({ server: { fs: { allow: ['..'] } } });
