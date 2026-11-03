// SPDX-License-Identifier: Apache-2.0
// Minimal Docker Engine client over the daemon socket (M4-05): `node:http` only, no new
// dependency. Covers exactly what the docker-local provider needs — version probe, networks,
// container lifecycle, exec with multiplexed output, and file put/get via the archive API.
// Anything richer (builds, volumes, plugins) stays out: the D5 rules forbid most of it.
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";

export interface EngineOptions {
  socketPath: string;
  /** Per-request ceiling; exec uses its own timeout instead. */
  timeoutMs?: number;
}

export class EngineError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "EngineError";
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function engineErrorStatus(error: unknown): number | null {
  return error instanceof EngineError ? error.status : null;
}

export class DockerEngine {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(options: EngineOptions) {
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Raw request: resolves JSON bodies, rejects non-2xx as `EngineError`. */
  async call<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const data = await this.raw(method, path, payload, "application/json", signal);
    if (data.length === 0) return undefined as T;
    return JSON.parse(data.toString("utf8")) as T;
  }

  /** Raw request with an explicit body and content type (archive up/download). */
  async raw(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: Buffer | null,
    contentType: string | null,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy(new EngineError(`docker engine ${method} ${path} timed out`, 0));
      }, this.timeoutMs);
      const onAbort = () => {
        req.destroy(new EngineError(`docker engine ${method} ${path} aborted`, 0));
      };
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method,
          path: `/v1.47${path}`,
          headers: {
            ...(contentType ? { "Content-Type": contentType } : {}),
            ...(body ? { "Content-Length": String(body.length) } : {}),
          },
        },
        (res) => {
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) return resolve();
            const detail = Buffer.concat(chunks).toString("utf8").slice(0, 500);
            reject(
              new EngineError(`docker engine ${method} ${path}: HTTP ${status} ${detail}`, status),
            );
          });
          res.on("error", (error) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          });
        },
      );
      req.on("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (body) req.write(body);
      req.end();
    });
    return Buffer.concat(chunks);
  }

  /**
   * Starts an exec instance and demuxes the multiplexed stream (`stdout`/`stderr` frames)
   * into `onOutput`, resolving with the frames complete. With `stdin`, the connection is
   * hijacked (the daemon upgrades the request): the bytes stream as exec stdin — riding
   * separately from argv, never a command line (M4-00a AC1c, M4-04 AC7) — while output
   * frames come back on the same connection.
   */
  async startExec(
    execId: string,
    onOutput: (stream: "stdout" | "stderr", text: string) => void,
    options: {
      stdin?: string | undefined;
      signal?: AbortSignal | undefined;
      timeoutMs?: number | undefined;
    } = {},
  ): Promise<void> {
    if (options.stdin !== undefined) {
      return this.startExecHijacked(execId, options.stdin, onOutput, options);
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        req.destroy();
        finish(new EngineError(`docker exec ${execId} timed out`, 0));
      }, options.timeoutMs ?? 120_000);
      const onAbort = () => {
        req.destroy();
        finish(new EngineError(`docker exec ${execId} aborted`, 0));
      };
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method: "POST",
          path: `/v1.47/exec/${execId}/start`,
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              finish(
                new EngineError(
                  `docker exec start: HTTP ${status} ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`,
                  status,
                ),
              ),
            );
            return;
          }
          // Multiplexed framing: 8-byte header (stream kind, 3 zero bytes, BE length).
          let pending = Buffer.alloc(0);
          const pump = (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 8) {
              const kind = pending[0];
              const length = pending.readUInt32BE(4);
              if (pending.length < 8 + length) return;
              const text = pending.subarray(8, 8 + length).toString("utf8");
              pending = pending.subarray(8 + length);
              onOutput(kind === 2 ? "stderr" : "stdout", text);
            }
          };
          res.on("data", pump);
          res.on("end", () => finish());
          res.on("error", (error) => finish(error));
        },
      );
      req.on("error", (error) => finish(error));
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      req.end();
    });
  }

  /**
   * Starts an exec instance over a hijacked socket connection: the start config goes out as
   * one HTTP request, then the raw stdin bytes stream in while multiplexed output frames
   * stream back. A half-close (FIN after the bytes) tells the process stdin hit EOF.
   */
  private startExecHijacked(
    execId: string,
    stdin: string,
    onOutput: (stream: "stdout" | "stderr", text: string) => void,
    options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        finish(new EngineError(`docker exec ${execId} timed out`, 0));
      }, options.timeoutMs ?? 120_000);
      const onAbort = () => {
        finish(new EngineError(`docker exec ${execId} aborted`, 0));
      };
      const fail = (status: string, detail: Buffer) =>
        finish(
          new EngineError(
            `docker exec start: HTTP ${status} ${detail.toString("utf8").slice(0, 300)}`,
            Number(status.split(" ")[0]) || 0,
          ),
        );
      const socket = createConnection(this.socketPath);
      let header = Buffer.alloc(0);
      let headersDone = false;
      let pending = Buffer.alloc(0);
      const pumpFrame = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 8) {
          const kind = pending[0] ?? 0;
          const length = pending.readUInt32BE(4);
          if (pending.length < 8 + length) return;
          const text = pending.subarray(8, 8 + length).toString("utf8");
          pending = pending.subarray(8 + length);
          onOutput(kind === 2 ? "stderr" : "stdout", text);
        }
      };
      socket.on("connect", () => {
        const config = JSON.stringify({ Detach: false, Tty: false });
        socket.write(
          `POST /v1.47/exec/${execId}/start HTTP/1.1\r\n` +
            "Host: localhost\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: tcp\r\n" +
            "Content-Type: application/json\r\n" +
            `Content-Length: ${Buffer.byteLength(config)}\r\n\r\n` +
            config,
        );
        socket.write(Buffer.from(stdin, "utf8"));
        socket.end();
      });
      socket.on("data", (chunk: Buffer) => {
        if (!headersDone) {
          header = Buffer.concat([header, chunk]);
          const end = header.indexOf("\r\n\r\n");
          if (end === -1) return;
          const statusLine = header.subarray(0, header.indexOf("\r\n")).toString("utf8");
          const status = statusLine.replace(/^HTTP\/\d+\.\d+ /, "").trim();
          const rest = header.subarray(end + 4);
          headersDone = true;
          header = Buffer.alloc(0);
          if (!/^101|^200/.test(status)) return fail(status, rest);
          if (rest.length > 0) pumpFrame(rest);
          return;
        }
        pumpFrame(chunk);
      });
      socket.on("end", () => finish());
      socket.on("close", () => finish());
      socket.on("error", (error) => finish(error));
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Builds a minimal ustar archive holding one regular file (mode 644). */
export function tarSingleFile(name: string, data: Uint8Array): Buffer {
  const clean = name.replace(/^\/+/, "");
  const header = Buffer.alloc(512, 0);
  const nameBytes = Buffer.from(clean, "utf8");
  if (nameBytes.length > 100) throw new Error(`tar path too long: ${name}`);
  nameBytes.copy(header, 0);
  header.write("0000644\0", 100, "utf8"); // mode
  header.write("0000000\0", 116, "utf8"); // uid
  header.write("0000000\0", 124, "utf8"); // gid
  const sizeOctal = `${data.length.toString(8).padStart(11, "0")}\0`;
  header.write(sizeOctal, 124 + 12 - 11, "utf8"); // size at 124
  header.write("        ", 148, "utf8"); // checksum placeholder (spaces)
  header[156] = 0x30; // regular file
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  const blocks = Math.ceil(data.length / 512) * 512;
  const body = Buffer.alloc(blocks, 0);
  Buffer.from(data).copy(body, 0);
  return Buffer.concat([header, body, Buffer.alloc(1024, 0)]);
}

interface TarEntry {
  name: string;
  data: Buffer;
}

/** Reads a ustar archive into its regular-file entries (enough for the archive API). */
export function untar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(
      header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(),
      8,
    );
    const type = String.fromCharCode(header[156] ?? 0);
    offset += 512;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > buffer.length) break;
    if ((type === "0" || type === "\0") && name.length > 0) {
      entries.push({ name, data: Buffer.from(buffer.subarray(offset, offset + size)) });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function isEngineRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}
