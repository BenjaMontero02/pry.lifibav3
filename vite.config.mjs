import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CSP solo en el build. En produccion las ventanas cargan con file:// y los headers
// HTTP no aplican, por eso va como <meta>. No se aplica en dev: el preambulo inline de
// react-refresh y el WebSocket de HMR la romperian.
// 'unsafe-inline' en style-src: React usa atributos style={...} (style-src-attr) y
// Tailwind genera CSS en archivo. No se permite ningun script inline ni eval.
const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: sourcephoto: sourcethumb:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' blob: data: sourcephoto: sourcethumb:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join("; ");

function contentSecurityPolicyPlugin() {
  return {
    name: "app-content-security-policy",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const metaTag = `<meta http-equiv="Content-Security-Policy" content="${APP_CONTENT_SECURITY_POLICY}" />`;
        // Despues de charset (que tiene que estar en los primeros 1024 bytes) y antes de los scripts.
        if (/<meta charset=[^>]*>/i.test(html)) {
          return html.replace(/<meta charset=[^>]*>/i, (charsetTag) => `${charsetTag}\n    ${metaTag}`);
        }
        return html.replace(/<head>/i, `<head>\n    ${metaTag}`);
      }
    }
  };
}

export default defineConfig(({ command }) => ({
  // En build las ventanas se cargan con file:// desde el asar, por eso los assets
  // deben referenciarse de forma relativa al html.
  base: command === "build" ? "./" : "/",
  plugins: [react(), tailwindcss(), contentSecurityPolicyPlugin()],
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
}));
