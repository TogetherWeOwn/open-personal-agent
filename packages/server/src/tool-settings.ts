// SPDX-License-Identifier: Apache-2.0
// Settings › Apps & tools and the approvals policy (M3-02 AC2, AC7; M3-19 AC1-2). Each tool has a
// decision override `{auto, ask, never}` the engine's floors still apply to. Loosening one needs
// the 5-minute account step-up and, like every change, writes an audit row with both values.
import { createRepository, isId } from "@opa/db/repository";
import { loosens, type ToolManifest, type ToolOverride } from "@opa/policy";
import { type Context, Hono } from "hono";
import type { AppEnv } from "./env";
import { hasStepUp } from "./session";
import { builtinTools } from "./tools";

type Ctx = Context<AppEnv>;
const policyOf = (c: Ctx) => createRepository(c.env).forUser(c.var.session.scope).policy;
const OVERRIDES: readonly (ToolOverride | null)[] = ["auto", "ask", "never", null];

const view = (m: ToolManifest, override: ToolOverride | null) => ({
  name: m.name,
  description: m.description,
  riskClass: m.riskClass,
  egress: m.destinations.some((d) => d.dataEgress),
  override,
  // An irreversible tool always asks with a passkey (the AC2 floor), so `auto` isn't offered.
  locked: m.riskClass === "irreversible",
});

export const toolSettings = new Hono<AppEnv>();

toolSettings.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

toolSettings.get("/tools", async (c) => {
  const overrides = await policyOf(c).overrides();
  const tools = builtinTools.manifests().map((m) => view(m, overrides.get(m.name) ?? null));
  return c.json({ tools });
});

/** Body `{ override: "auto" | "ask" | "never" | null }`; `null` returns the tool to its default. */
toolSettings.put("/tools/:name", async (c) => {
  const manifest = builtinTools.get(c.req.param("name"))?.manifest;
  if (!manifest) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const to = body?.override as ToolOverride | null;
  if (!OVERRIDES.includes(to)) return c.json({ error: "invalid_override" }, 400);
  const policy = policyOf(c);
  const from = (await policy.overrides()).get(manifest.name) ?? null;
  const change = { tool: manifest.name, from, to, riskClass: manifest.riskClass };
  if (to === "auto" && manifest.riskClass === "irreversible") {
    // An attempted floor breach is the highest-signal refusal: audit it like the others.
    await policy.setOverride(change, "denied");
    return c.json({ error: "floor_irreversible" }, 400);
  }
  if (from === to) return c.json(view(manifest, to));
  if (loosens(manifest.riskClass, from, to) && !hasStepUp(c.var.session)) {
    await policy.setOverride(change, "denied");
    return c.json({ error: "step_up_required" }, 403);
  }
  await policy.setOverride(change);
  return c.json(view(manifest, to));
});

/** The user's live standing grants, for Settings › Privacy & security › Approvals. */
toolSettings.get("/grants", async (c) => c.json({ grants: await policyOf(c).grants(Date.now()) }));

/** Revokes one grant. Tightening, so no step-up. Another user's grant is a 404. */
toolSettings.delete("/grants/:id", async (c) => {
  const id = c.req.param("id");
  if (!isId(id) || !(await policyOf(c).revoke(id))) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});
