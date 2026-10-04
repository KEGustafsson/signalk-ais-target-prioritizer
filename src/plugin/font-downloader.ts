import { existsSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { extract } from "tar";
import { Readable } from "node:stream";
import type { IRouter } from "express";

const FONTS_DIR = path.join(__dirname, "../public/assets/protomaps/fonts");
const SPRITES_DIR = path.join(__dirname, "../public/assets/protomaps/sprites");
const FONTS_URL =
  "https://github.com/protomaps/basemaps-assets/archive/refs/heads/main.tar.gz";
const DOWNLOAD_TIMEOUT = 5 * 60_000; // milliseconds

// the pack is extracted into a directory the server serves on its own origin, so
// only plain font and sprite files may land there - an .html file in the archive
// would otherwise be served as a page with the user's signal k session
const ALLOWED_EXTENSIONS = new Set([".pbf", ".json", ".png"]);

export function isFontPackEntry(filePath: string, entry: object): boolean {
  if (!filePath.includes("/fonts/") && !filePath.includes("/sprites/")) {
    return false;
  }
  // extraction hands us tar's ReadEntry, which names its type ("File", "Directory",
  // "SymbolicLink", ...) - anything else is refused
  const type = "type" in entry ? entry.type : undefined;
  if (type === "Directory") return true;
  if (type !== "File" && type !== "OldFile") return false;
  return ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

let downloading = false;

export function registerAssetEndpoints(router: IRouter) {
  // check if fonts are installed
  router.get(`/fonts-available`, (req, res) => {
    const available =
      existsSync(FONTS_DIR) && readdirSync(FONTS_DIR).length > 0;
    res.status(available ? 200 : 404).json({ available });
  });

  // trigger font download from github
  router.post(`/download-fonts`, async (req, res) => {
    // one at a time - concurrent extractions into the same directory, or a stream
    // of requests re-downloading the pack over a metered link, help nobody
    if (downloading) {
      res.status(409).json({ error: "download already in progress" });
      return;
    }
    downloading = true;
    try {
      mkdirSync(FONTS_DIR, { recursive: true });
      mkdirSync(SPRITES_DIR, { recursive: true });

      const response = await fetch(FONTS_URL, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
      });
      if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);

      if (!response.body) throw new Error("No response body");

      await pipeline(
        Readable.fromWeb(response.body as import("stream/web").ReadableStream),
        extract({
          cwd: path.join(__dirname, "../public/assets/protomaps"),
          strip: 1,
          filter: isFontPackEntry,
        }),
      );

      res.json({ success: true });
    } catch (err) {
      console.error("Font download failed:", err);
      res.status(500).json({ error: String(err) });
    } finally {
      downloading = false;
    }
  });

  // remove fonts
  router.post(`/remove-fonts`, (req, res) => {
    try {
      if (existsSync(FONTS_DIR)) rmSync(FONTS_DIR, { recursive: true });
      if (existsSync(SPRITES_DIR)) rmSync(SPRITES_DIR, { recursive: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}
