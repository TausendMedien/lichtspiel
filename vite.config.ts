import { execSync } from "child_process";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Bump this when releasing a significant new version
const BASE_VERSION = "0.3";

const buildVersion = (() => {
  // Format timestamp in Europe/Berlin timezone: YYMMDD-HHmm
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const ts = `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
  return `v${BASE_VERSION}.${ts}`;
})();

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ["**/*.{js,css,html,ico,png,svg,wasm}"],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
      manifest: false,
    }),
  ],
  base: "/lichtspiel/",
  define: {
    __VERSION__: JSON.stringify(buildVersion),
  },
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT) : 5173,
  },
});
