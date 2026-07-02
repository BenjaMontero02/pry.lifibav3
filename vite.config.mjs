import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/release/**",
        "**/dist/**",
        "**/.venv/**",
        "**/.playwright-mcp/**",
        "**/resources/python/**",
        "**/python/**/__pycache__/**"
      ]
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        operator: path.resolve(__dirname, "operator.html"),
        player: path.resolve(__dirname, "player.html")
      }
    }
  }
});
