// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
const app = new Hono();
app.get("/", (c) => c.text(getCookie(c, "x") ?? "ok"));
export default app;
