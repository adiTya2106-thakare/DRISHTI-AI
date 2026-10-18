import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'fs';

// Vite config for Chrome Manifest V3 extension
// Multiple entry points: popup, dashboard, background SW, content script
export default defineConfig({
  // Use relative paths so the extension works from any chrome-extension:// origin
  base: './',
  plugins: [
    react(),
    {
      name: 'copy-manifest-and-assets',
      closeBundle() {
        // Copy manifest
        copyFileSync('src/manifest.json', 'dist/manifest.json');
        // Copy icons if they exist
        const iconSrc = 'public/icons';
        const iconDst = 'dist/icons';
        if (existsSync(iconSrc)) {
          if (!existsSync(iconDst)) mkdirSync(iconDst, { recursive: true });
          try {
            for (const f of readdirSync(iconSrc)) {
              copyFileSync(`${iconSrc}/${f}`, `${iconDst}/${f}`);
            }
          } catch { /* ignore */ }
        }
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        dashboard: resolve(__dirname, 'src/dashboard/index.html'),
        background: resolve(__dirname, 'src/background/background.ts'),
        content: resolve(__dirname, 'src/content/content.ts'),
        'inference-worker': resolve(__dirname, 'src/workers/inference-worker.ts'),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'background') return 'background/background.js';
          if (chunk.name === 'content') return 'content/content.js';
          if (chunk.name === 'inference-worker') return 'workers/inference-worker.js';
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  worker: {
    format: 'es',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
