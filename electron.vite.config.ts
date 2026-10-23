import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // micromatch / electron-updater 要跟着主进程 bundle 走：打包配置排除了
    // node_modules，外部化它们会让安装包里缺依赖
    plugins: [externalizeDepsPlugin({ exclude: ['micromatch', 'electron-updater'] })],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    // Monaco 的 worker 在 Electron file:// 下用 iife 更稳，避免模块 worker
    // 被当成跨源脚本拦掉。
    worker: { format: 'iife' },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    },
    plugins: [react()]
  }
})
