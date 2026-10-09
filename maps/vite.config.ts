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
      proxy: {
        // Proxy the hosted PMTiles (which are CORS-locked to github.io) so the
        // map works from localhost. Set VITE_TILE_ROOT_URL=/raw.
        '/raw': {
          target: 'https://maps.truckermudgeon.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/raw/, ''),
        },
      },
    },
    plugins: [react(), viteTsconfigPaths()],
  };
});
