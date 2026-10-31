// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import { type Env, makeAuth } from "./auth";

const app = new Hono<{ Bindings: Env }>();
app.on(["GET", "POST"], "/api/auth/*", (c) => makeAuth(c.env).handler(c.req.raw));
app.get("/api/me", async (c) => {
  const s = await makeAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  return s ? c.json({ userId: s.user.id }) : c.json({ error: "unauthenticated" }, 401);
});
export default app;
