// SPDX-License-Identifier: Apache-2.0
// Settings › Assistant (M3-09 AC3): the persisted "Show work" choice. Mounted at
// `/api/settings/assistant`. The thread reads it on load; the Assistant page writes it.
import { createRepository } from "@opa/db/repository";
import { type Context, Hono } from "hono";
import type { AppEnv } from "./env";

type Ctx = Context<AppEnv>;
const userOf = (c: Ctx) => createRepository(c.env).forUser(c.var.session.scope);

const DEFAULT = "collapsed";
const isShowWork = (value: unknown): value is typeof DEFAULT | "hidden" | "expanded" =>
  value === "hidden" || value === "collapsed" || value === "expanded";

export const assistantSettings = new Hono<AppEnv>();

assistantSettings.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

assistantSettings.get("/", async (c) => {
  const row = await userOf(c).settings.get();
  // No settings row yet, or a value from before the choice existed, reads as the default.
  const showWork = row?.showWork;
  return c.json({ showWork: isShowWork(showWork) ? showWork : DEFAULT });
});

/** Body `{ showWork: "hidden" | "collapsed" | "expanded" }`. */
assistantSettings.put("/", async (c) => {
  const showWork = (await c.req.json().catch(() => null))?.showWork;
  if (!isShowWork(showWork)) return c.json({ error: "invalid_setting" }, 400);
  await userOf(c).settings.save({ showWork });
  return c.json({ showWork });
});
