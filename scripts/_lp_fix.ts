import { readFileSync, writeFileSync } from "node:fs";

const path = "src/lib/preset-defaults.ts";
const ids = ["lightPaint", "lightTrail", "lightPaintBlack", "lightFly", "lightVortex", "lightKaleido", "lightGlitch"];
const gainFix = ["lightPaint", "lightGlitch"];
const FADE = [0.01, 0.01, 0.015];

const lines = readFileSync(path, "utf8").split("\n");

for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^(\s*)'([^']+)':\s*(\[.*\]),\s*$/);
  if (!m) continue;
  const [, indent, id, arrJson] = m;
  if (!ids.includes(id)) continue;

  const slots = JSON.parse(arrJson) as Array<Record<string, number | boolean | string>>;
  slots.forEach((s, idx) => {
    if ("Fade Speed" in s) s["Fade Speed"] = FADE[idx];
    if (gainFix.includes(id) && "Gain" in s) s["Gain"] = 0.5;
  });

  lines[i] = `${indent}'${id}': ${JSON.stringify(slots)},`;
  console.log(`updated ${id}`);
}

writeFileSync(path, lines.join("\n"));
