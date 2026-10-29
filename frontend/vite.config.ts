import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2021', // Safari 15 (macOS 12 WebKit) and WebView2
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5173, strictPort: true },
});
