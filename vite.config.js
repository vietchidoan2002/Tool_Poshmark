import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Tesseract requests <langPath>/eng.traineddata.gz by its fixed name.
        assetFileNames: asset => asset.name === 'eng.traineddata.gz'
          ? 'assets/ocr/[name][extname]' : 'assets/[name]-[hash][extname]',
      },
    },
  },
})
