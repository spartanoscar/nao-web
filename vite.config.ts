import { defineConfig } from 'vite';

const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  // Aislamiento entre orígenes (COOP/COEP): habilita SharedArrayBuffer, y con él los hilos de
  // WebAssembly; sin esto la voz sin GPU (onnxruntime WASM) corre en un núcleo, más lenta que tiempo real.
  // Producción: las mismas cabeceras en deploy/nginx/nao.bukivo.com.conf.
  // /api va a nao-api (server/); en local: `go run .` en server/ con NAO_DB_URL (túnel SSH a la base)
  server: { port: 5180, headers: ISOLATION, proxy: { '/api': { target: 'http://127.0.0.1:3030', ws: true } } },
  preview: { headers: ISOLATION },
  // MuJoCo trae su propio .wasm (se pasa con ?url): el pre-bundling de Vite lo rompería
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  // La voz (Kokoro) corre en un worker de módulo: import.meta y los imports ES tienen que conservarse
  worker: { format: 'es' },
  // Dos páginas: el mundo (index.html) y el control del teléfono (control.html, se abre con el QR).
  // three.js solo ya pesa ~500 kB: el aviso de tamaño por defecto no aporta
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { main: 'index.html', control: 'control.html' } },
  },
});
