import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_CONVEX_URL': JSON.stringify(env.VITE_CONVEX_URL || env.CONVEX_URL || ''),
      'import.meta.env.VITE_CONVEX_SITE_URL': JSON.stringify(env.VITE_CONVEX_SITE_URL || env.CONVEX_SITE_URL || ''),
    },
    build: {
      target: 'es2022',
      outDir: 'dist/demo',
      emptyOutDir: true,
    },
  };
});
