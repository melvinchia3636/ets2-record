import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import viteTsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig(() => {
  return {
    build: {
      outDir: 'build',
      copyPublicDir: false,
    },
    server: {
      open: false,
      port: 5188,
    },
    plugins: [react(), viteTsconfigPaths()],
  };
});
