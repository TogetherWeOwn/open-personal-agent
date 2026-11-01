// SPDX-License-Identifier: Apache-2.0
// Status and trust chips: always an icon plus text, never colour alone (m3-ux §1.3, §3.7, §4.7).
import {
  Check,
  CircleX,
  Clock,
  Gauge,
  Globe,
  Hand,
  Loader,
  Lock,
  type LucideIcon,
  Sparkles,
  Square,
  TriangleAlert,
  User,
  Wallet,
} from "lucide-react";

/** The eight task statuses (M3-13 AC1). */
export type Status =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "budget_limited"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

const statuses: Record<Status, [label: string, icon: LucideIcon, color: string]> = {
  queued: ["Queued", Clock, "text-text-muted"],
  running: ["Working", Loader, "text-status-info"],
  waiting_for_approval: ["Needs your OK", Hand, "text-status-warning"],
  budget_limited: ["Paused: budget", Wallet, "text-status-warning"],
  succeeded: ["Done", Check, "text-status-success"],
  failed: ["Failed", CircleX, "text-danger"],
  cancelled: ["Stopped", Square, "text-text-muted"],
  interrupted: ["Interrupted", TriangleAlert, "text-status-warning"],
};

export type Trust = "system" | "user" | "inferred" | "external";

const trusts: Record<Trust, [label: string, icon: LucideIcon]> = {
  system: ["Built in", Lock],
  user: ["You told me", User],
  inferred: ["I worked this out", Sparkles],
  external: ["From a web page or file", Globe],
};

function Chip({
  label,
  Icon,
  color,
  spin = false,
}: {
  label: string;
  Icon: LucideIcon;
  color: string;
  spin?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-sm font-medium ${color}`}
    >
      <Icon aria-hidden="true" size={14} className={spin ? "motion-safe:animate-spin" : ""} />
      {label}
    </span>
  );
}

/** `limit` marks a `budget_limited` stop by an execution limit, not money (m3-ux §1.3, P1). */
export function StatusChip({ status, limit = false }: { status: Status; limit?: boolean }) {
  const [label, Icon, color] =
    status === "budget_limited" && limit
      ? (["Paused: limit", Gauge, statuses.budget_limited[2]] as const)
      : statuses[status];
  return <Chip label={label} Icon={Icon} color={color} spin={status === "running"} />;
}

export function TrustChip({ trust }: { trust: Trust }) {
  const [label, Icon] = trusts[trust];
  return <Chip label={label} Icon={Icon} color="text-text" />;
}
