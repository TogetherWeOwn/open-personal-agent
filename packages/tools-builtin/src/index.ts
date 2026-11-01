// SPDX-License-Identifier: Apache-2.0
// The built-in tools (M3-08): the registry every first-party tool joins. Runtime-agnostic — the
// host (the Assistant DO on Workers, the Node root, a Workflow step) supplies the ports, already
// scoped to the calling user, plus its runtime's fetch: the SSRF-guarded page fetch on Node, the
// runtime fetch plus the deployment's own hostname on Workers. `remember`/`recall`/`forget`
// (M3-14b) and `task` (M3-13) register here too when they land (M3-08 AC5).
import type { LoopTool } from "@opa/harness-builtin";
import { ToolRegistry } from "@opa/policy";
import { createArtifactTool, type FilePorts, readFileTool } from "./files";
import { type SearchHistoryPorts, searchHistoryTool } from "./search-history";
import { WEB_FETCH_CAPS, type WebFetchCaps, type WebFetchPorts, webFetchTool } from "./web-fetch";

export * from "./files";
export * from "./search-history";
export * from "./web-fetch";

/** Everything the built-in tools need, scoped to one user by the host before they get here. */
export type BuiltinToolPorts = WebFetchPorts & SearchHistoryPorts & FilePorts;

export function builtinTools(
  ports: BuiltinToolPorts,
  caps: WebFetchCaps = WEB_FETCH_CAPS,
): LoopTool[] {
  return [
    webFetchTool(ports, caps),
    searchHistoryTool(ports),
    createArtifactTool(ports),
    readFileTool(ports),
  ];
}

/** The built-in tools in a registry (M3-02 AC1: a tool without a manifest can't register). */
export function builtinToolRegistry(
  ports: BuiltinToolPorts,
  caps: WebFetchCaps = WEB_FETCH_CAPS,
): ToolRegistry<LoopTool> {
  const registry = new ToolRegistry<LoopTool>();
  for (const tool of builtinTools(ports, caps)) registry.register(tool);
  return registry;
}
