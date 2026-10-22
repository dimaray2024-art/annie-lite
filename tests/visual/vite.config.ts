import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 独立粒子预览与 Electron renderer 使用相同的路径别名。
export default defineConfig({
  root: resolve(__dirname, '../..'),
  plugins: [react()],
  resolve: { alias: { '@shared': resolve(__dirname, '../../shared') } },
  server: { host: '127.0.0.1' }
})
