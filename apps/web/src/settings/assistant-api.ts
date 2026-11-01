// SPDX-License-Identifier: Apache-2.0
// `GET/PUT /api/settings/assistant` (M3-09 AC3). Anything unexpected reads as the default,
// so a thread never breaks on a value from before the choice existed.
import { parseShowWork, type ShowWork } from "../chat/show-work";

async function call(init?: RequestInit): Promise<ShowWork> {
  const res = await fetch("/api/settings/assistant", init);
  if (!res.ok) throw new Error(String(res.status));
  return parseShowWork((await res.json())?.showWork);
}

export const getShowWork = () => call();

/** Saves the choice; the server refuses anything but the three values. */
export const saveShowWork = (showWork: ShowWork) =>
  call({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ showWork }),
  });
