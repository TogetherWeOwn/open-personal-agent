// SPDX-License-Identifier: Apache-2.0
// The data export API (M3-20 AC1, m3-ux §3.11): the row history newest first, and starting an
// export. Exporting is an account action: the first 403 runs the passkey step-up and retries,
// once. A start while one runs answers 409 with the running row, which this client adopts
// rather than reports — the screen's "already being made" state is that row.
import { ensureAccountStepUp } from "./step-up";

export interface DataExport {
  id: string;
  status: "running" | "ready" | "failed" | "expired";
  sizeBytes: number | null;
  createdAt: number;
  readyAt: number | null;
  expiresAt: number;
  error: string | null;
}

const err = (body: unknown) => new Error((body as { error?: string }).error ?? "request_failed");

async function readError(res: Response): Promise<Error> {
  return err(await res.json().catch(() => ({})));
}

/** The row history, newest first. */
export async function listExports(): Promise<DataExport[]> {
  const res = await fetch("/api/exports");
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as { exports: DataExport[] }).exports;
}

/**
 * A passkey step-up in this session, for the account actions that require one. One ceremony
 * lives in `./step-up`; this stays as the name export and deletion call it.
 */
export const stepUpSession = ensureAccountStepUp;

/** Starts an export, adopting the running one when the server says one is being made. */
export async function startExport(retried = false): Promise<DataExport> {
  const res = await fetch("/api/exports", { method: "POST" });
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      export?: DataExport;
    };
    if (body.error === "step_up_required" && !retried) {
      await stepUpSession();
      return startExport(true);
    }
    throw err(body);
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      export?: DataExport;
    };
    if (body.error === "already_running" && body.export) return body.export;
    throw err(body);
  }
  if (!res.ok) throw await readError(res);
  return (await res.json()) as DataExport;
}

/** `sizeBytes` as the list shows it; `null` while the export has no file yet. */
export function formatBytes(sizeBytes: number | null): string | null {
  if (sizeBytes === null) return null;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  let size = sizeBytes / 1024;
  let unit = "KB";
  for (const next of ["MB", "GB"] as const) {
    if (size < 1024) break;
    size /= 1024;
    unit = next;
  }
  const rounded = size >= 100 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${unit}`;
}
