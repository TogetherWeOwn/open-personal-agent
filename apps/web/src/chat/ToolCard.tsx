// SPDX-License-Identifier: Apache-2.0
// One tool card (M3-09 AC3, m3-ux §3.1): the step's summary opens to its canonical arguments,
// output preview, size and error. Shared with Task details (M3-13).
import { CircleCheck, CircleX, Loader } from "lucide-react";
import { Disclosure } from "../ui";
import { formatBytes } from "./attachments";
import type { TurnTool } from "./state";

const statusText = (status: TurnTool["status"]) =>
  status === "running" ? "Running…" : status === "ok" ? "Done" : "Failed";

function StatusIcon({ status }: { status: TurnTool["status"] }) {
  if (status === "running")
    return <Loader aria-hidden="true" size={14} className="motion-safe:animate-spin" />;
  if (status === "ok") return <CircleCheck aria-hidden="true" size={14} />;
  return <CircleX aria-hidden="true" size={14} />;
}

export function ToolCard({ tool, defaultOpen }: { tool: TurnTool; defaultOpen?: boolean }) {
  const failed = tool.status === "error";
  return (
    <Disclosure
      defaultExpanded={defaultOpen ?? failed}
      summary={
        <span
          className={`inline-flex items-center gap-1.5 text-sm ${failed ? "text-danger" : "text-text-muted"}`}
        >
          <StatusIcon status={tool.status} />
          <span className="font-mono">{tool.tool}</span>
          <span className="sr-only">: </span>
          <span>{statusText(tool.status)}</span>
        </span>
      }
    >
      <dl className="flex flex-col gap-2 text-sm">
        <div>
          <dt className="font-medium text-text-muted">Arguments</dt>
          <dd>
            <pre className="max-h-48 overflow-auto rounded-lg bg-surface-raised p-2 text-xs break-all whitespace-pre-wrap">
              {tool.args}
            </pre>
          </dd>
        </div>
        {tool.preview !== null && tool.preview !== "" && (
          <div>
            <dt className="font-medium text-text-muted">Output</dt>
            <dd className="break-words whitespace-pre-wrap">{tool.preview}</dd>
          </div>
        )}
        {tool.bytes !== null && (
          <div>
            <dt className="sr-only">Size</dt>
            <dd className="text-text-muted">{formatBytes(tool.bytes)}</dd>
          </div>
        )}
        {tool.error !== undefined && (
          <div>
            <dt className="font-medium text-danger">Error</dt>
            <dd className="break-words whitespace-pre-wrap text-danger">{tool.error}</dd>
          </div>
        )}
      </dl>
    </Disclosure>
  );
}
