import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // ws 的可选原生加速依赖在 bundle 里会被 Vite 换成空对象（truthy），
    // 大帧走到 bufferUtil.mask 时直接炸。显式关掉这两条原生优化，
    // 让 ws 使用自己的 JS mask / UTF-8 校验。
    define: {
      'process.env.WS_NO_BUFFER_UTIL': '"1"',
      'process.env.WS_NO_UTF_8_VALIDATE': '"1"'
    },
    // micromatch / electron-updater / fzstd / MCP 格式库要跟着主进程 bundle 走：
    // 打包配置排除了 node_modules，外部化它们会让安装包里缺依赖
    plugins: [
      externalizeDepsPlugin({
        exclude: ['micromatch', 'electron-updater', 'fzstd', 'jsonc-parser', 'smol-toml', 'yaml', 'ws']
      })
    ],
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
