import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5273,
    proxy: {
      '/api': {
        target: 'http://localhost:5274',
        changeOrigin: true
      }
    }
  }
})
