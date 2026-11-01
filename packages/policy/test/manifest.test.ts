// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  ManifestError,
  manifestProblems,
  type RegisteredTool,
  type ToolManifest,
  ToolRegistry,
} from "../src/index";

const webFetch: ToolManifest = {
  name: "web_fetch",
  description: "Fetch a web page.",
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  riskClass: "read",
  destinations: [{ id: "web", kind: "third_party", dataEgress: true }],
  scopes: ["web:read"],
};

const web = webFetch.destinations[0];
const dests = (...destinations: unknown[]) => ({ ...webFetch, destinations });
const schema = (keywords: object) => ({
  ...webFetch,
  inputSchema: { ...webFetch.inputSchema, ...keywords },
});

describe("manifestProblems", () => {
  it("accepts a complete manifest", () => {
    expect(manifestProblems(webFetch)).toEqual([]);
  });

  it.each([
    ["no manifest", undefined, "no manifest"],
    ["a bad name", { ...webFetch, name: "Web Fetch" }, "name must be"],
    ["no description", { ...webFetch, description: " " }, "description is required"],
    ["a non-object schema", { ...webFetch, inputSchema: { type: "string" } }, "inputSchema"],
    ["an unknown risk class", { ...webFetch, riskClass: "harmless" }, "riskClass must be"],
    ["no destinations list", { ...webFetch, destinations: undefined }, "destinations must"],
    ["a destination with no id", { ...webFetch, destinations: [{}] }, "needs an id"],
    ["a duplicate destination", dests(web, web), "declared twice"],
    ["an unknown destination kind", dests({ ...web, kind: "mine" }), "kind must be"],
    ["undeclared egress", dests({ id: "x", kind: "control_plane" }), "must declare dataEgress"],
    ["a third party without egress", dests({ ...web, dataEgress: false }), "can't be false"],
    [
      "schema properties that aren't schemas",
      schema({ properties: { url: "string" } }),
      "properties",
    ],
    ["schema required that isn't a list", schema({ required: "url" }), "required must"],
    ["schema required naming no property", schema({ required: ["uri"] }), "isn't declared"],
    ["a bad additionalProperties", schema({ additionalProperties: "no" }), "additionalProperties"],
    ["no scopes list", { ...webFetch, scopes: "web:read" }, "scopes must be"],
    ["duplicate scopes", { ...webFetch, scopes: ["a", "a"] }, "duplicates"],
  ])("rejects %s", (_, manifest, problem) => {
    expect(manifestProblems(manifest).join("; ")).toContain(problem);
  });

  it("rejects a manifest with a reference cycle, which JSON can never express", () => {
    const cyclic = { ...webFetch } as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(manifestProblems(cyclic).join("; ")).toContain("plain data");
  });
});

describe("ToolRegistry", () => {
  it("registers a tool with a manifest and looks it up by name", () => {
    const registry = new ToolRegistry<RegisteredTool & { describe(): string }>();
    class WebFetch {
      manifest = webFetch;
      run = () => "ok";
      describe() {
        return this.manifest.description;
      }
    }
    const tool = new WebFetch();
    registry.register(tool);
    expect(registry.get("web_fetch")?.tool).toBe(tool);
    expect(registry.get("web_fetch")?.tool.describe()).toBe("Fetch a web page.");
    expect(registry.get("web_fetch")?.manifest).toEqual(webFetch);
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.manifests().map((m) => m.name)).toEqual(["web_fetch"]);
  });

  it("refuses a tool without a valid manifest, or a second tool of the same name", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register({} as { manifest: ToolManifest })).toThrow(ManifestError);
    const bad = { manifest: { ...webFetch, riskClass: "harmless" } } as unknown;
    expect(() => registry.register(bad as { manifest: ToolManifest })).toThrow(/web_fetch/);
    registry.register({ manifest: webFetch });
    expect(() => registry.register({ manifest: webFetch })).toThrow(/exists/);
  });

  it("keeps the risk class and egress as registered, whatever later happens to the input", () => {
    const registry = new ToolRegistry();
    const tool = { manifest: structuredClone(webFetch) };
    registry.register(tool);
    tool.manifest.riskClass = "irreversible";
    const stored = registry.get("web_fetch")?.manifest;
    expect(stored?.riskClass).toBe("read");
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.destinations[0])).toBe(true);
    expect(Object.isFrozen(stored?.inputSchema.properties)).toBe(true);
  });

  it("stores the manifest it validated, even when the tool's getter changes its answer", () => {
    const registry = new ToolRegistry();
    let reads = 0;
    const shifty = {
      get manifest(): ToolManifest {
        reads += 1;
        return reads === 1 ? webFetch : (dests({ ...web, dataEgress: false }) as ToolManifest);
      },
    };
    registry.register(shifty);
    expect(reads).toBe(1);
    expect(registry.get("web_fetch")?.manifest.destinations).toEqual([web]);
  });

  it("refuses a manifest that isn't plain data", () => {
    const registry = new ToolRegistry();
    const tool = { manifest: { ...webFetch, inputSchema: { type: "object", check: () => true } } };
    expect(() => registry.register(tool as { manifest: ToolManifest })).toThrow(/plain data/);
  });

  it("refuses a manifest with a reference cycle instead of overflowing the stack", () => {
    const registry = new ToolRegistry();
    const cyclic = { ...webFetch } as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(() => registry.register({ manifest: cyclic } as { manifest: ToolManifest })).toThrow(
      ManifestError,
    );
    expect(registry.get("web_fetch")).toBeUndefined();
  });
});
