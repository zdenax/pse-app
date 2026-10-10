import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` keeps the build working from any folder (GitHub Pages, Tauri, a file server).
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { fs: { allow: [".."] } },
  test: {
    globals: true,
    environment: "node",
  },
});
