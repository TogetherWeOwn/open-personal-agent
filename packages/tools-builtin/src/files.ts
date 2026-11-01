// SPDX-License-Identifier: Apache-2.0
// `create_artifact` and `read_file` (M3-08 AC3): the model's files. The ports are the caller's
// scoped repository slice, which stores under `u/{userId}/` only and refuses ids that could
// escape that prefix — so a model-supplied id can never reach another user's files, and a
// missing file and someone else's file answer identically. The display name is just a name:
// the artifact id, minted by the host, is the handle for reading back.
import type { LoopTool, ToolOutput } from "@opa/harness-builtin";
import type { ToolManifest } from "@opa/policy";

export type FilePorts = {
  /**
   * Stored under the caller's `u/{userId}/` prefix; `id` must be a single safe segment. The host
   * records it in Outputs under `name`, with the run that wrote it as its source (M3-11).
   */
  putFile(id: string, content: string, contentType: string, name: string): Promise<unknown>;
  /** The caller's file with this id, or `null` when there is none (or it isn't theirs). */
  getFile(id: string): Promise<{ text(): Promise<string> } | null>;
  /** Mints artifact ids (single safe segments). */
  newId(): string;
};

/** What the model may create: text artifacts only. Attachments (M3-10b) bring binary files. */
const TYPES = ["text/markdown", "text/plain", "text/html", "application/json", "text/csv"] as const;
const BY_EXTENSION: Record<string, (typeof TYPES)[number]> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  csv: "text/csv",
};

/** How much of a file the model is shown (the rest of the file is untouched). */
const MAX_READ_CHARS = 50_000;

const failed = (content: string): ToolOutput => ({
  ok: false,
  content,
  context: { kind: "system" },
});

const hasControl = (text: string): boolean =>
  [...text].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

/** The `create_artifact` manifest, exported so Settings can list the tool without its ports. */
export const CREATE_ARTIFACT_MANIFEST: ToolManifest = {
  name: "create_artifact",
  description:
    "Save a text file for the user (notes, a draft, a table, code) so it appears in their " +
    "Outputs. Returns an artifact id you can read back with read_file. Use it for anything " +
    "the user would want to keep, instead of pasting a long document into the chat.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: 'The file name the user sees, e.g. "trip-plan.md".',
      },
      content: {
        type: "string",
        maxLength: 262_144,
        description: "The whole file content.",
      },
      type: {
        type: "string",
        enum: [...TYPES],
        description: "The content type; guessed from the name when omitted.",
      },
    },
    required: ["name", "content"],
    additionalProperties: false,
  },
  riskClass: "write_reversible",
  destinations: [{ id: "files", kind: "control_plane", dataEgress: false }],
  scopes: ["files:write"],
};

export function createArtifactTool(ports: FilePorts): LoopTool {
  return {
    manifest: CREATE_ARTIFACT_MANIFEST,
    target(input) {
      return typeof input.name === "string" ? input.name : undefined;
    },
    async execute(input, signal) {
      const name = String(input.name ?? "").trim();
      // The name is display-only (the id is the storage key), but keep it a plain file name so
      // Outputs never shows a path.
      if (name === "" || name === "." || name === ".." || /[/\\]/.test(name) || hasControl(name)) {
        return failed("The artifact needs a plain file name, without slashes.");
      }
      // Like search_history and web_fetch: a cancelled turn starts nothing. putFile itself
      // isn't abort-aware, so check before the await; a write that committed before the abort
      // landed is announced with its id rather than orphaned — the turn still ends cancelled,
      // and the loop only emits artifact.created for a call that actually ran.
      if (signal.aborted) return failed("The save was cancelled.");
      const content = String(input.content ?? "");
      const extension = name.toLowerCase().split(".").pop() ?? "";
      const type =
        typeof input.type === "string" && (TYPES as readonly string[]).includes(input.type)
          ? input.type
          : (BY_EXTENSION[extension] ?? "text/plain");
      const artifactId = ports.newId();
      try {
        await ports.putFile(artifactId, content, type, name);
      } catch {
        return failed("The file couldn't be saved.");
      }
      const bytes = new TextEncoder().encode(content).length;
      return {
        ok: true,
        content:
          `Created "${name}" (${bytes} bytes). ` +
          `Its artifact id is ${artifactId}; read it back with read_file.`,
        // This sentence is the tool's own; writing the user's file adds no outside content.
        context: { kind: "system" },
        artifact: { artifactId, name, type, bytes },
      };
    },
  };
}

/** The `read_file` manifest, exported so Settings can list the tool without its ports. */
export const READ_FILE_MANIFEST: ToolManifest = {
  name: "read_file",
  description:
    "Read back a file from the user's files by its artifact id (the id create_artifact " +
    "returned, or one the user gives you). Only this user's files can be read.",
  inputSchema: {
    type: "object",
    properties: {
      artifactId: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description: "The artifact id of the file.",
      },
    },
    required: ["artifactId"],
    additionalProperties: false,
  },
  riskClass: "read",
  destinations: [{ id: "files", kind: "control_plane", dataEgress: false }],
  scopes: ["files:read"],
};

export function readFileTool(ports: FilePorts): LoopTool {
  return {
    manifest: READ_FILE_MANIFEST,
    async execute(input, signal) {
      const artifactId = String(input.artifactId ?? "");
      let text: string;
      try {
        const file = await ports.getFile(artifactId);
        if (!file) return failed("There is no file with that artifact id.");
        text = await file.text();
      } catch {
        // A malformed id (a path, say) is refused by the storage layer; answer exactly as for a
        // missing file, so ids can't be probed.
        return failed("There is no file with that artifact id.");
      }
      // No side effects here, but a cancelled turn announces nothing either.
      if (signal.aborted) return failed("The read was cancelled.");
      const truncated = text.length > MAX_READ_CHARS;
      return {
        ok: true,
        content: truncated
          ? `${text.slice(0, MAX_READ_CHARS)}\n\n[Truncated at ${MAX_READ_CHARS} characters.]`
          : text,
        // A file's content is outside content, whoever saved it (M3-02 AC3).
        context: { kind: "file", label: artifactId },
      };
    },
  };
}
