import {
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { extract } from "tar";
import { Readable } from "node:stream";
import type { IRouter } from "express";

const ASSETS_DIR = path.join(__dirname, "../public/assets/protomaps");
const PACK_DIRS = ["fonts", "sprites"] as const;
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

// swap the staged fonts/ and sprites/ in for the live ones as a unit. the live
// folders are moved aside (into the staging folder, so the finally that removes it
// cleans them up), not deleted: if any step fails, everything moved so far is put
// back, so a failure leaves the previous pack intact rather than half replaced
function installStagedPack(assetsDir: string, staging: string) {
  const backedUp: { live: string; backup: string }[] = [];
  const installed: string[] = [];
  try {
    for (const dir of PACK_DIRS) {
      const staged = path.join(staging, dir);
      if (!existsSync(staged)) continue;
      const live = path.join(assetsDir, dir);
      if (existsSync(live)) {
        const backup = path.join(staging, `previous-${dir}`);
        renameSync(live, backup);
        backedUp.push({ live, backup });
      }
      renameSync(staged, live);
      installed.push(live);
    }
  } catch (err) {
    for (const live of installed)
      rmSync(live, { recursive: true, force: true });
    for (const { live, backup } of backedUp) renameSync(backup, live);
    throw err;
  }
}

export function registerAssetEndpoints(
  router: IRouter,
  assetsDir: string = ASSETS_DIR,
) {
  const fontsDir = path.join(assetsDir, "fonts");

  // check if fonts are installed
  router.get(`/fonts-available`, (req, res) => {
    const available = existsSync(fontsDir) && readdirSync(fontsDir).length > 0;
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
    let staging: string | undefined;
    try {
      mkdirSync(assetsDir, { recursive: true });
      // unpack beside the live pack and swap it in only once the whole download
      // has succeeded: a failure or timeout part way through would otherwise leave
      // a partial pack that /fonts-available reports as installed
      staging = mkdtempSync(path.join(assetsDir, ".download-"));

      const response = await fetch(FONTS_URL, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
      });
      if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);

      if (!response.body) throw new Error("No response body");

      await pipeline(
        Readable.fromWeb(response.body as import("stream/web").ReadableStream),
        extract({
          cwd: staging,
          strip: 1,
          filter: isFontPackEntry,
        }),
      );

      const stagedFonts = path.join(staging, "fonts");
      if (!existsSync(stagedFonts) || readdirSync(stagedFonts).length === 0) {
        throw new Error("font pack contained no fonts");
      }

      installStagedPack(assetsDir, staging);

      res.json({ success: true });
    } catch (err) {
      console.error("Font download failed:", err);
      res.status(500).json({ error: String(err) });
    } finally {
      if (staging) rmSync(staging, { recursive: true, force: true });
      downloading = false;
    }
  });

  // remove fonts
  router.post(`/remove-fonts`, (req, res) => {
    try {
      for (const dir of PACK_DIRS) {
        rmSync(path.join(assetsDir, dir), { recursive: true, force: true });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}
