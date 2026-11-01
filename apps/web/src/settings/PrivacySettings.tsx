// SPDX-License-Identifier: Apache-2.0
// Privacy & security, first axis: downloading your data (M3-20 AC1, m3-ux §3.11). An export is
// a ZIP of your chats, memories, tasks, files, settings and usage history, made in the
// background and downloadable for one hour. While one is being made the button waits on it
// instead of starting another; the list below is the row history newest first.
import { useEffect, useState } from "react";
import { Heading } from "react-aria-components";
import { Button, buttonClass, Card, CardHeader } from "../ui";
import { type DataExport, formatBytes, listExports, startExport } from "./export-api";

const ERRORS: Record<string, string> = {
  workflow_unavailable: "Exports aren't available on this server right now. Try again later.",
  start_failed: "The export couldn't start. Try again in a moment.",
  conflict: "The export couldn't start. Try again in a moment.",
  step_up_required: "Confirm it's you with your passkey first, then try again.",
};

function when(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function ExportRow({ row }: { row: DataExport }) {
  if (row.status === "running") return null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-3">
      <div className="flex flex-col gap-0.5">
        {row.status === "ready" ? (
          <>
            <span className="font-medium">
              Ready{formatBytes(row.sizeBytes) ? ` · ${formatBytes(row.sizeBytes)}` : ""}
            </span>
            <span className="text-sm text-text-muted">
              Made {when(row.createdAt)} · available until {when(row.expiresAt)}
            </span>
          </>
        ) : row.status === "failed" ? (
          <>
            <span className="font-medium">Couldn't make this export</span>
            <span className="text-sm text-text-muted">
              {row.error ?? "Something went wrong."} Start a new one below.
            </span>
          </>
        ) : (
          <span className="text-sm text-text-muted">Expired {when(row.expiresAt)}</span>
        )}
      </div>
      {row.status === "ready" && (
        // A plain anchor, not the router's Link: the download is a file response the SPA
        // must not intercept into a client-side navigation.
        <a
          href={`/api/exports/${row.id}`}
          download={`export-${row.id}.zip`}
          className={buttonClass("secondary")}
        >
          Download
        </a>
      )}
    </li>
  );
}

export function PrivacySettings() {
  const [rows, setRows] = useState<DataExport[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const runningId = rows?.find((row) => row.status === "running")?.id ?? null;
  const running = runningId !== null;

  useEffect(() => {
    let cancelled = false;
    // A failed load says so and offers a retry: an empty list would read as "no exports".
    setLoadFailed(false);
    listExports().then(
      (exports) => !cancelled && setRows(exports),
      () => {
        if (cancelled) return;
        setRows([]);
        setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  // While an export is being made, refresh the list until it lands somewhere.
  useEffect(() => {
    if (runningId === null) return;
    const timer = setInterval(() => {
      listExports().then(setRows, () => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [runningId]);

  const start = async () => {
    setStarting(true);
    setError("");
    try {
      const row = await startExport();
      setRows((prev) => [row, ...(prev ?? []).filter((other) => other.id !== row.id)]);
    } catch (e: unknown) {
      setError(ERRORS[(e as Error).message] ?? "That didn't work. Try again in a moment.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div data-testid="data-export">
      <Card labelledBy="data-export-heading">
        <CardHeader id="data-export-heading" title="Download your data" />
        <p>
          Your chats, memories, tasks, files, settings and usage history, as one ZIP file. Making it
          takes a few seconds; the download stays available for one hour.
        </p>
        {rows === null ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : loadFailed ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-danger">
              Couldn't load your exports.
            </p>
            <Button variant="secondary" onPress={() => setReloads((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            {running && (
              <p role="status" className="text-sm">
                Making your export… it will appear below when it's ready.
              </p>
            )}
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
            <div>
              <Button
                variant="primary"
                className="self-start"
                isDisabled={starting || running}
                onPress={() => void start()}
              >
                {starting ? "Starting…" : running ? "Making your export…" : "Download your data"}
              </Button>
            </div>
            {rows.some((row) => row.status !== "running") && (
              <ul aria-label="Past exports">
                {rows.map((row) => (
                  <ExportRow key={row.id} row={row} />
                ))}
              </ul>
            )}
            <Heading level={4} className="text-sm font-semibold">
              What's inside
            </Heading>
            <p className="text-sm text-text-muted">
              Every conversation with its messages, your memories, tasks, uploaded files and the
              files made for you, your settings and usage history. Saved model keys are never
              included.
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
