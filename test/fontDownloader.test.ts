import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

import {
  isFontPackEntry,
  registerAssetEndpoints,
} from "../src/plugin/font-downloader";

const file = { type: "File" };

describe("isFontPackEntry", () => {
  it("accepts the glyphs and sprites the map asks for", () => {
    expect(isFontPackEntry("x/fonts/Noto Sans/0-255.pbf", file)).toBe(true);
    expect(isFontPackEntry("x/sprites/v4/light.json", file)).toBe(true);
    expect(isFontPackEntry("x/sprites/v4/light@2x.png", file)).toBe(true);
    expect(isFontPackEntry("x/fonts/Noto Sans/", { type: "Directory" })).toBe(
      true,
    );
  });

  // the pack lands in a directory served on the signal k origin
  it("refuses anything a browser would run", () => {
    expect(isFontPackEntry("x/fonts/p.html", file)).toBe(false);
    expect(isFontPackEntry("x/fonts/p.svg", file)).toBe(false);
    expect(isFontPackEntry("x/sprites/p.js", file)).toBe(false);
  });

  it("refuses links and other entry types", () => {
    expect(isFontPackEntry("x/fonts/a.pbf", { type: "SymbolicLink" })).toBe(
      false,
    );
    expect(isFontPackEntry("x/fonts/a.pbf", { type: "Link" })).toBe(false);
    expect(isFontPackEntry("x/fonts/a.pbf", {})).toBe(false);
  });

  it("refuses anything outside fonts and sprites", () => {
    expect(isFontPackEntry("x/README.json", file)).toBe(false);
  });
});

describe("downloading the font pack", () => {
  let dir: string;
  let routes: Record<string, Handler>;

  type Handler = (
    req: unknown,
    res: { status: (n: number) => unknown; json: (b: unknown) => unknown },
  ) => Promise<void> | void;

  async function call(route: string) {
    const out = { statusCode: 200, body: undefined as unknown };
    const res = {
      status(n: number) {
        out.statusCode = n;
        return res;
      },
      json(b: unknown) {
        out.body = b;
        return res;
      },
    };
    await routes[route]({}, res);
    return out;
  }

  // a gzipped tarball shaped like the github archive: one top-level folder
  async function pack(files: Record<string, string>): Promise<Buffer> {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "fontpack-src-"));
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(src, name)), { recursive: true });
      fs.writeFileSync(path.join(src, name), content);
    }
    const chunks: Buffer[] = [];
    const stream = tar.c({ gzip: true, cwd: src }, Object.keys(files));
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    fs.rmSync(src, { recursive: true, force: true });
    return Buffer.concat(chunks);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fontpack-"));
    routes = {};
    const add = (method: string) => (route: string, h: Handler) => {
      routes[`${method} ${route}`] = h;
    };
    registerAssetEndpoints(
      { get: add("GET"), post: add("POST") } as never,
      dir,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("installs the fonts and sprites from a good download", async () => {
    const body = await pack({
      "p/fonts/Noto/0-255.pbf": "glyphs",
      "p/sprites/v4/light.json": "{}",
      "p/fonts/evil.html": "<script>",
    });
    vi.stubGlobal("fetch", async () => new Response(body));

    expect((await call("POST /download-fonts")).statusCode).toBe(200);
    expect(
      fs.readFileSync(path.join(dir, "fonts/Noto/0-255.pbf"), "utf8"),
    ).toBe("glyphs");
    expect(fs.existsSync(path.join(dir, "sprites/v4/light.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "fonts/evil.html"))).toBe(false);
    // no staging folder left behind
    expect(fs.readdirSync(dir).sort()).toEqual(["fonts", "sprites"]);
    expect((await call("GET /fonts-available")).statusCode).toBe(200);
  });

  it("leaves the installed pack alone when a download fails part way", async () => {
    fs.mkdirSync(path.join(dir, "fonts/Old"), { recursive: true });
    fs.writeFileSync(path.join(dir, "fonts/Old/0-255.pbf"), "old");

    const body = await pack({ "p/fonts/New/0-255.pbf": "new".repeat(5000) });
    // deliver part of the archive, then fail - a timeout or a dropped link
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(body.subarray(0, body.length / 2));
              controller.error(new Error("connection reset"));
            },
          }),
        ),
    );

    expect((await call("POST /download-fonts")).statusCode).toBe(500);
    expect(fs.readFileSync(path.join(dir, "fonts/Old/0-255.pbf"), "utf8")).toBe(
      "old",
    );
    expect(fs.existsSync(path.join(dir, "fonts/New"))).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(["fonts"]);
  });

  it("does not report a failed first download as installed", async () => {
    vi.stubGlobal("fetch", async () => new Response("not a tarball"));

    expect((await call("POST /download-fonts")).statusCode).toBe(500);
    expect((await call("GET /fonts-available")).statusCode).toBe(404);
  });
});
