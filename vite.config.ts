import { execSync } from "child_process";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Bump this when releasing a significant new version
const BASE_VERSION = "0.6";

const buildVersion = (() => {
  // Use the git commit timestamp so the version is fixed at commit time,
  // not at build time — ensures the version I report after pushing matches
  // exactly what appears in the app.
  let commitUnix: number;
  try {
    commitUnix = parseInt(execSync("git log -1 --format=%ct").toString().trim(), 10);
  } catch {
    commitUnix = Math.floor(Date.now() / 1000);
  }
  const now = new Date(commitUnix * 1000);
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
