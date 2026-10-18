import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin API calls in development: cookies and CSRF behave as they will in production.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: false } },
  },
});
