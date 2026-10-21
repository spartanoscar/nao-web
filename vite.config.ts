import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180 },
  // MuJoCo trae su propio .wasm (se pasa con ?url): el pre-bundling de Vite lo rompería
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  // three.js solo ya pesa ~500 kB; el aviso por defecto no aporta
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
