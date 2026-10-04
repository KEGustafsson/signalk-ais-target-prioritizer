import { describe, it, beforeAll } from "vitest";
import assert from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

describe("signalk-ais-target-prioritizer", () => {
  let pluginModule;

  beforeAll(async () => {
    const pluginPath = path.resolve(process.cwd(), "plugin/index.cjs");
    pluginModule = await import(pathToFileURL(pluginPath).href);
  });

  it("loads as a valid SignalK plugin", () => {
    assert.ok(pluginModule, "Module loaded");
  });

  // signal k require()s the bundle and calls module.exports as the plugin factory.
  // a named export on the entry would turn it into { default, ... } - which the
  // tests below would still accept through .default, but the server would not
  it("exports the plugin factory itself as module.exports", () => {
    const required = createRequire(import.meta.url)(
      path.resolve(process.cwd(), "plugin/index.cjs"),
    );
    assert.strictEqual(typeof required, "function");
  });

  // the bundle is installed with production dependencies only
  it("requires no devDependency at runtime", () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    );
    const bundle = readFileSync(
      path.resolve(process.cwd(), "plugin/index.cjs"),
      "utf8",
    );
    const required = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    for (const id of required) {
      if (id.startsWith("node:")) continue;
      const name = id.startsWith("@")
        ? id.split("/").slice(0, 2).join("/")
        : id.split("/")[0];
      assert.ok(
        name in (pkg.dependencies ?? {}),
        `${name} is required by the bundle but not a dependency`,
      );
    }
  });

  it("initializes and returns a valid plugin object", () => {
    const mockApp = createMockApp();

    // This matches your build output
    const factory =
      pluginModule.default?.default || pluginModule.default || pluginModule;

    assert.strictEqual(
      typeof factory,
      "function",
      "Found plugin factory function",
    );

    const plugin = factory(mockApp);

    assert.ok(plugin, "Plugin instance created");
    assert.ok(plugin.id, "Has id");
    assert.ok(plugin.name, "Has name");
    assert.ok(plugin.schema, "Has schema");
    assert.strictEqual(typeof plugin.start, "function", "Has start()");
    assert.strictEqual(typeof plugin.stop, "function", "Has stop()");
  });

  it("starts and stops cleanly in registry test environment", () => {
    const mockApp = createMockApp();

    const factory =
      pluginModule.default?.default || pluginModule.default || pluginModule;
    const plugin = factory(mockApp);

    process.env.SIGNALK_REGISTRY_TEST = "1";

    assert.doesNotThrow(() => {
      plugin.start({}, () => {}); // options + restart callback
    }, "start() should not throw");

    assert.doesNotThrow(() => {
      plugin.stop();
    }, "stop() should not throw");
  });

  it("has a valid schema", () => {
    const mockApp = createMockApp();

    const factory =
      pluginModule.default?.default || pluginModule.default || pluginModule;
    const plugin = factory(mockApp);

    assert.ok(plugin.schema, "Schema exists");
    assert.strictEqual(typeof plugin.schema, "object");
  });
});

// Minimal SignalK mock
function createMockApp() {
  return {
    debug: () => {},
    error: () => {},
    selfContext:
      "vessels.urn:mrn:signalk:uuid:12345678-1234-1234-1234-123456789abc",
    getDataDirPath: () => "/tmp/signalk-test-data",
    subscriptionmanager: { subscribe: () => ({}) },
    handleMessage: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    getPath: () => null,
  };
}
