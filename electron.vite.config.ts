import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve(__dirname, 'shared') } },
    build: {
      outDir: 'dist-electron',
      rollupOptions: {
        // worker 必须是独立入口：它是被 Worker 按路径加载的，不能打进主进程的 bundle
        input: {
          main: resolve(__dirname, 'electron/main.ts'),
          'wake-word-worker': resolve(__dirname, 'electron/wake-worker.ts')
        },
        // 原生模块不能打包
        external: ['ws', 'sherpa-onnx-node'],
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    resolve: { alias: { '@shared': resolve(__dirname, 'shared') } },
    build: {
      // sandbox: true 的 preload 必须是 CommonJS，所以强制 cjs 且不带 .mjs 后缀
      lib: {
        entry: resolve(__dirname, 'electron/preload.ts'),
        formats: ['cjs'],
        fileName: () => 'preload.js'
      },
      outDir: 'dist-electron',
      // main 与 preload 共用 outDir，preload 后构建会清掉 main 的产物
      emptyOutDir: false
    }
  },
  renderer: {
    root: '.',
    plugins: [react()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    },
    build: {
      outDir: 'dist',
      rollupOptions: { input: resolve(__dirname, 'index.html') }
    }
  }
})
