// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import type { Env } from "./env";

export const app = new Hono<{ Bindings: Env }>();

// Stub: M2-04 replaces this with the real schema, binding and secret checks.
app.get("/api/health", (c) => c.json({ status: "ok" }));

app.notFound((c) => c.json({ error: "not_found" }, 404));
