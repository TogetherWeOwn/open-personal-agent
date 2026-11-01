// SPDX-License-Identifier: Apache-2.0
// Settings › Computer (M3-19 AC1, m3-ux §3.9): this deployment runs Configuration A — no
// computer — so the page explains what that means instead of offering one. Configurations B
// and C build on an M4 computer, so until one lands there is nothing to set up.
import { Heading } from "react-aria-components";

export function Computer() {
  return (
    <section aria-labelledby="computer-heading" className="flex flex-col gap-4">
      <Heading level={2} id="computer-heading" className="text-xl font-semibold">
        Computer
      </Heading>
      <p className="font-semibold">Not set up.</p>
      <p>
        Your assistant works without one; it just can't browse like a person or run code. It reads
        pages and files through its tools instead, and anything it fetches is marked where you see
        it.
      </p>
      <p>
        A computer — a sandboxed browser and shell of your own, in the M4 milestone — would let it
        click through sites and run programs. Configurations B and C need one, so until it lands
        there is nothing to set up.
      </p>
    </section>
  );
}
