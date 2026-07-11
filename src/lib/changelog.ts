// Parses CHANGELOG.md into structured entries for the in-app "About" changelog
// view, so there's a single source of truth — edit CHANGELOG.md, the app view
// picks it up automatically.

import raw from "../../CHANGELOG.md?raw";

export interface ChangelogEntry {
  version: string;
  title: string;
  paragraphs: string[];
}

function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const blocks = text.split(/^## /m).slice(1); // drop the "# Changelog" preamble
  for (const block of blocks) {
    const lines = block.split("\n");
    const header = lines[0].trim();
    const dashIdx = header.indexOf(" — ");
    const version = dashIdx >= 0 ? header.slice(0, dashIdx).trim() : header;
    const title = dashIdx >= 0 ? header.slice(dashIdx + 3).trim() : "";
    const paragraphs = lines
      .slice(1)
      .join("\n")
      .split(/\n{2,}/)
      .map(p => p.trim())
      .filter(p => p.length > 0 && p !== "---");
    entries.push({ version, title, paragraphs });
  }
  return entries;
}

export const CHANGELOG: ChangelogEntry[] = parseChangelog(raw);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `**bold**` -> `<strong>` — everything else HTML-escaped. Safe to use with
 *  {@html}: input is our own checked-in CHANGELOG.md, not user data. */
export function inlineMarkdownToHtml(s: string): string {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
