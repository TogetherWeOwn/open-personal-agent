// SPDX-License-Identifier: Apache-2.0
// What a Test found (M3-06 AC4): how fast the model answered, whether it can call tools, and
// what it costs. Shared by onboarding and Settings › Models.
import { per100Messages, priceChecked, type TestResult } from "./settings-api";

/** The probe's verdict in words. Only a refusal or a text answer counts against tools. */
function toolsLine(test: Extract<TestResult, { ok: true }>): string {
  switch (test.toolProbe) {
    case "called":
      return "Supported";
    case "ignored":
    case "rejected":
      return "Not supported";
    case "timeout":
    case "failed":
      return "Couldn't tell — the check didn't finish. Test again to be sure.";
    default:
      return test.tools ? "Supported" : "Not supported";
  }
}

export function TestResultView({ test }: { test: TestResult }) {
  if (!test.ok) return <p role="alert">The model didn't answer: {test.error.message}</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt>Latency</dt>
      <dd>{test.latencyMs} ms to the first word</dd>
      <dt>Tool calls</dt>
      <dd>{toolsLine(test)}</dd>
      {test.price !== undefined && (
        <>
          <dt>Price</dt>
          <dd>
            {test.price
              ? `${per100Messages(test.price)} (${priceChecked(test.price)})`
              : "No price on file"}
          </dd>
        </>
      )}
      <dt>Reply</dt>
      <dd>{test.reply || "(empty)"}</dd>
    </dl>
  );
}
