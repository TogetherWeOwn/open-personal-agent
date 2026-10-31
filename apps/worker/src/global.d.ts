// SPDX-License-Identifier: Apache-2.0

// Types `exports` from "cloudflare:workers" with this Worker's entry module.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
}
