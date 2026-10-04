import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

// make one rename fail - moving the staged sprites into place - to check that a
// failure part way through installing leaves the previous pack as it was
let failSpritesInstall = false;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (
      failSpritesInstall &&
      path.basename(String(from)) === "sprites" &&
      String(from).includes(".download-")
    ) {
      throw new Error("simulated rename failure");
    }
    return actual.renameSync(from, to);
  };
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});

const fs = await import("node:fs");
const { registerAssetEndpoints } =
  await import("../src/plugin/font-downloader");

type Handler = (
  req: unknown,
  res: { status: (n: number) => unknown; json: (b: unknown) => unknown },
) => Promise<void> | void;

async function pack(files: Record<string, string>): Promise<Buffer> {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "fontpack-src-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, name)), { recursive: true });
    fs.writeFileSync(path.join(src, name), content);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of tar.c({ gzip: true, cwd: src }, Object.keys(files)))
    chunks.push(Buffer.from(chunk));
  fs.rmSync(src, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

describe("installing the font pack", () => {
  let dir: string;
  let download: Handler;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fontpack-"));
    registerAssetEndpoints(
      {
        get: () => {},
        post: (route: string, h: Handler) => {
          if (route === "/download-fonts") download = h;
        },
      } as never,
      dir,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    failSpritesInstall = false;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restores the previous pack when installing fails part way", async () => {
    fs.mkdirSync(path.join(dir, "fonts/Old"), { recursive: true });
    fs.writeFileSync(path.join(dir, "fonts/Old/0-255.pbf"), "old fonts");
    fs.mkdirSync(path.join(dir, "sprites/v4"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sprites/v4/light.json"), "old sprites");

    const body = await pack({
      "p/fonts/New/0-255.pbf": "new fonts",
      "p/sprites/v4/light.json": "new sprites",
    });
    vi.stubGlobal("fetch", async () => new Response(body));
    failSpritesInstall = true;

    let status = 200;
    const res = {
      status(n: number) {
        status = n;
        return res;
      },
      json: () => res,
    };
    await download({}, res);

    expect(status).toBe(500);
    // fonts were already swapped in when sprites failed - they must be rolled back
    expect(fs.readFileSync(path.join(dir, "fonts/Old/0-255.pbf"), "utf8")).toBe(
      "old fonts",
    );
    expect(fs.existsSync(path.join(dir, "fonts/New"))).toBe(false);
    expect(
      fs.readFileSync(path.join(dir, "sprites/v4/light.json"), "utf8"),
    ).toBe("old sprites");
    expect(fs.readdirSync(dir).sort()).toEqual(["fonts", "sprites"]);
  });
});
