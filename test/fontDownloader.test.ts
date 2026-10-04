import { describe, it, expect } from "vitest";

import { isFontPackEntry } from "../src/plugin/font-downloader";

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
