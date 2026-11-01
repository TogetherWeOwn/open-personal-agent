// SPDX-License-Identifier: Apache-2.0
// Types `exports` from "cloudflare:workers" with the combined spike Worker.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./both-worker");
  }
}
