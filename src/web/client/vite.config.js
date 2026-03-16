import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // In dev (vite serve) the app runs at root so /api/... proxy works as-is.
  // In production builds the app lives at /loot/, so asset paths and
  // import.meta.env.BASE_URL are automatically prefixed with /loot/.
  base: command === 'build' ? '/loot/' : '/',
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
}));
