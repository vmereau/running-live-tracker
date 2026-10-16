// Two pages: the live map at / and the Story 1.2 stream diagnostic, kept for
// the Story 4.3 soak test. In dev, /api is proxied to the local server.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: page('./index.html'),
        diagnostic: page('./diagnostic.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
