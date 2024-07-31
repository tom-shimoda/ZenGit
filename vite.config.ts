import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build:{
    rollupOptions:{
      input:{
        index: "./index.html",
        
        // npm run tauri devだと問題ないが、npm run tauri buildのビルド品だとhtmlが正常に読み込まれなかった。
        // ビルド時に生成されるdistフォルダに該当のhtmlが含まれないのが原因。
        // (参考: https://stackoverflow.com/questions/76176712/is-there-a-way-to-compile-and-bundle-another-html-file-in-tauri)
        // commit_info_windowはラベル名。しかしコードからこのラベルを使用していなくとも動くのでたぶんなんでもよさそう。
        commit_info_window: "./src/commit_info_window.html"
      }
    }
  }
}));
