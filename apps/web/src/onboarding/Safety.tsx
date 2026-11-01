// SPDX-License-Identifier: Apache-2.0
// "How I ask before acting" (M3-24 AC1, m3-ux §3.12): the default policy in four lines and the real
// approval card as a sample. Onboarding's Safety step and the checklist's sheet both show it.
import { DEFAULT_POLICY_LINES, RISK_CLASSES } from "@opa/policy";
import { useState } from "react";
import { ApprovalCard } from "../approvals/ApprovalCard";
import { sampleBatch } from "../approvals/sample";

export function SafetyExplainer({ level = 3 }: { level?: number }) {
  const [batch] = useState(() => sampleBatch());
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex list-disc flex-col gap-1 pl-6">
        {RISK_CLASSES.map((risk) => (
          <li key={risk}>{DEFAULT_POLICY_LINES[risk]}</li>
        ))}
      </ul>
      <ApprovalCard batch={batch} level={level} idPrefix="sample" sample />
    </div>
  );
}
