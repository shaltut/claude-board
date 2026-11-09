import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  // Keep the browser's Host (changeOrigin: false): the server refuses a POST whose Origin host differs
  // from Host (CSRF), and Vite's string shorthand would rewrite Host to the target.
  server: { proxy: { '/api': { target: process.env.CB_API ?? 'http://127.0.0.1:4747', changeOrigin: false } } },
})
