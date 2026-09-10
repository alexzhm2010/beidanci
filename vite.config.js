import { defineConfig } from 'vite';

// Vite 构建配置
// - base: './'  → 产物使用相对路径, 兼容 GitHub Pages 子路径部署
// - build.rollupOptions.output.manualChunks: 第三方库独立 chunk, 便于浏览器缓存
// - 每个功能页 (learning/library/stats/admin) 通过动态 import() 自动形成独立 chunk,
//   实现按需加载, 首屏只加载核心层 (config/db/auth/algorithm)
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2018',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          // 第三方库: 大体积独立 chunk, 按需懒加载
          chart: ['chart.js'],
          xlsx: ['xlsx'],
          // tesseract.js 通过动态 CDN 引入, 不打进 bundle
        },
      },
    },
  },
});
