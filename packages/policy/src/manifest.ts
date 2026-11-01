// SPDX-License-Identifier: Apache-2.0
// Tool manifests (M3-02 AC1, ADR 0009 #6): every tool declares what it is before it can register.
// The manifest is a fact about the tool, so the registry freezes it: a user setting can tighten
// how a tool is decided (`ToolOverride`) but never change its `riskClass` or clear `dataEgress`.

export const RISK_CLASSES = ["read", "write_reversible", "consequential", "irreversible"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** Where a tool's call can send data. `dataEgress` belongs to the destination (ADR 0009 #6). */
export type ToolDestination = {
  id: string; // what the card names, e.g. "web" or "memory"
  kind: "control_plane" | "third_party"; // a third-party destination always has `dataEgress`
  dataEgress: boolean;
};

/** The JSON Schema of a tool's input: always an object, validated before policy runs (M3-03 AC2). */
export type ToolInputSchema = { type: "object"; [keyword: string]: unknown };

export type ToolManifest = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  riskClass: RiskClass;
  destinations: readonly ToolDestination[];
  scopes: readonly string[]; // what the tool can touch, e.g. "memory:write"
};

export class ManifestError extends Error {
  constructor(
    readonly tool: string,
    readonly problems: readonly string[],
  ) {
    super(`tool "${tool}" has an invalid manifest: ${problems.join("; ")}`);
    this.name = "ManifestError";
  }
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What is wrong with a manifest, or an empty list. It checks at runtime what the types already say,
 * because manifests from M5 plugins and MCP servers arrive as JSON.
 */
export function manifestProblems(manifest: unknown): string[] {
  if (!isRecord(manifest)) return ["no manifest"];
  const { name, description, inputSchema, riskClass, destinations, scopes } = manifest;
  const problems: string[] = [];
  if (typeof name !== "string" || !TOOL_NAME.test(name)) {
    problems.push("name must be 1-64 characters of a-z, 0-9 and _, starting with a letter");
  }
  if (typeof description !== "string" || description.trim() === "") {
    problems.push("description is required");
  }
  if (!isRecord(inputSchema) || inputSchema.type !== "object") {
    problems.push('inputSchema must be a JSON Schema with type "object"');
  }
  if (!RISK_CLASSES.includes(riskClass as RiskClass)) {
    problems.push(`riskClass must be one of ${RISK_CLASSES.join(", ")}`);
  }
  if (!Array.isArray(destinations)) {
    problems.push("destinations must be a list (empty for none)");
  } else {
    const ids = new Set<string>();
    for (const d of destinations) {
      if (!isRecord(d) || typeof d.id !== "string" || d.id === "") {
        problems.push("each destination needs an id");
        continue;
      }
      if (ids.has(d.id)) problems.push(`destination "${d.id}" is declared twice`);
      ids.add(d.id);
      if (d.kind !== "control_plane" && d.kind !== "third_party") {
        problems.push(`destination "${d.id}" kind must be control_plane or third_party`);
      }
      if (typeof d.dataEgress !== "boolean") {
        problems.push(`destination "${d.id}" must declare dataEgress`);
      } else if (d.kind === "third_party" && !d.dataEgress) {
        problems.push(`destination "${d.id}" is third-party, so dataEgress can't be false`);
      }
    }
  }
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string" || s === "")) {
    problems.push("scopes must be a list of non-empty strings (empty for none)");
  } else if (new Set(scopes).size !== scopes.length) {
    problems.push("scopes has duplicates");
  }
  return problems;
}

/** Whether any destination of the tool can receive data. */
export const hasEgress = (manifest: ToolManifest): boolean =>
  manifest.destinations.some((d) => d.dataEgress);

function freezeManifest(manifest: ToolManifest): ToolManifest {
  const copy = structuredClone(manifest);
  for (const d of copy.destinations) Object.freeze(d);
  Object.freeze(copy.destinations);
  Object.freeze(copy.scopes);
  return Object.freeze(copy);
}

export type RegisteredTool = { manifest: ToolManifest };

/** A registered tool and the frozen copy of its manifest the policy engine must read. */
export type ToolEntry<T> = { readonly tool: T; readonly manifest: ToolManifest };

/** The tools a turn can call. A tool without a valid manifest can't register (M3-02 AC1). */
export class ToolRegistry<T extends RegisteredTool = RegisteredTool> {
  readonly #tools = new Map<string, ToolEntry<T>>();

  register(tool: T): void {
    const manifest: unknown = (tool as { manifest?: unknown } | null)?.manifest;
    const label = isRecord(manifest) && typeof manifest.name === "string" ? manifest.name : "?";
    const problems = manifestProblems(manifest);
    if (problems.length > 0) throw new ManifestError(label, problems);
    if (this.#tools.has(label)) throw new ManifestError(label, ["a tool with this name exists"]);
    // The tool is kept as given (a class keeps its methods); only the manifest is copied.
    this.#tools.set(label, Object.freeze({ tool, manifest: freezeManifest(tool.manifest) }));
  }

  get(name: string): ToolEntry<T> | undefined {
    return this.#tools.get(name);
  }

  manifests(): ToolManifest[] {
    return [...this.#tools.values()].map((t) => t.manifest);
  }
}
