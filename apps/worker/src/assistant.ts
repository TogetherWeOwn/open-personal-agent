// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/** Per-user assistant (ADR 0002). Empty until the chat transport lands. */
export class Assistant extends DurableObject<Env> {}
