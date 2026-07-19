import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/healthz": "http://127.0.0.1:3001",
    },
    ...(isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : {}),
  },
});
