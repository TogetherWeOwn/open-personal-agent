// SPDX-License-Identifier: Apache-2.0
import { createRepository } from "@opa/db/repository";
import {
  APPROVAL_TTL_MS,
  bindBatch,
  bindingProblem,
  canonical,
  type PendingItem,
  parseInput,
} from "@opa/harness-builtin";
import {
  decide,
  fitsApproval,
  openApproval,
  sha256,
  toBase64Url,
  toolDefinitionHash,
} from "@opa/policy";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { attachmentMaxBytes, fileName, readAttachment, UploadError } from "./attachments";
import type { AppEnv, ArtifactNotifier, GatewayApprovalNotifier } from "./env";
import { composeTurnTools, parseOwnHosts } from "./turn-tools";

export const capabilityAudiences = new Hono<AppEnv>();

// Deliberately opt-in: future builtins, management tools, browser and generic fetch are not exposed.
const GATEWAY_TOOLS = new Set([
  "search_history",
  "create_artifact",
  "read_file",
  "remember",
  "recall",
  "forget",
]);

capabilityAudiences.post(
  "/tasks/:taskId/tools",
  bodyLimit({
    maxSize: 80 * 1024,
    onError: (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ error: "too_large" }, 413);
    },
  }),
  async (c) => {
    c.header("Cache-Control", "no-store");
    const capability = c.var.capability;
    if (capability?.aud !== "tool_gateway" || c.req.param("taskId") !== capability.taskId)
      return c.json({ error: "unauthenticated" }, 401);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) => !["task_id", "idempotencyKey", "tool", "arguments"].includes(key),
      ) ||
      body.task_id !== capability.taskId ||
      typeof body.tool !== "string" ||
      typeof body.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(body.idempotencyKey)
    )
      return c.json({ error: "bad_request" }, 400);
    if (!GATEWAY_TOOLS.has(body.tool)) return c.json({ error: "tool_not_allowed" }, 403);
    const repository = createRepository(c.env);
    const binding = await repository.scopeForCapability(capability);
    if (!binding) return c.json({ error: "unauthenticated" }, 401);
    const user = repository.forUser(binding.scope);
    const composed = await composeTurnTools({
      user,
      fetch: c.env.MODEL_FETCH ?? fetch,
      ownHosts: parseOwnHosts(c.env.OPA_OWN_HOSTS),
      newId: () => crypto.randomUUID(),
      taint: () => true,
      scope: { kind: "task", taskId: capability.taskId, conversationId: binding.conversationId },
    });
    const entry = composed.tools.get(body.tool);
    if (!entry) return c.json({ error: "tool_not_allowed" }, 403);
    const manifestHash = await toolDefinitionHash(entry.manifest);
    if (
      !capability.toolAllowlist?.some(
        (pin) => pin.tool === body.tool && pin.manifestHash === manifestHash,
      )
    )
      return c.json({ error: "tool_not_allowed" }, 403);
    let args: string;
    try {
      args = canonical(body.arguments);
    } catch {
      return c.json({ error: "invalid_input" }, 400);
    }
    const parsed = parseInput(entry.manifest.inputSchema, args);
    if (!parsed.ok) return c.json({ error: "invalid_input" }, 400);
    const input = parsed.input;
    const target = entry.tool.target?.(input);
    const policy = decide({
      manifest: entry.manifest,
      taint: "untrusted",
      ...composed.policy(body.tool),
      taskId: capability.taskId,
      ...(target === undefined ? {} : { target }),
      now: Date.now(),
    });
    const canPrepare = policy.outcome !== "ask" || fitsApproval(input, target ?? null);
    const requestHash = toBase64Url(
      await sha256(
        new TextEncoder().encode(
          canonical({
            tool: body.tool,
            args: input,
            manifestHash,
          }),
        ),
      ),
    );
    const store = repository.capabilityGateway(capability);
    // Reject new oversized approvals without reserving a key, but still recover prior outcomes.
    const begun = await store.begin(body.idempotencyKey, requestHash, canPrepare);
    if (begun.kind === "not_started") return c.json({ error: "invalid_input" }, 400);
    if (begun.kind === "quota") return c.json({ error: "call_quota" }, 429);
    if (begun.kind === "conflict") return c.json({ error: "idempotency_conflict" }, 409);
    let call = begun.call;
    const replay = () =>
      new Response(call.response, {
        status: call.statusCode ?? 500,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    if (call.status === "completed") return replay();
    const batchId = `gateway_${call.id}`;
    const waiting = () => c.json({ status: "approval_required", batchId, callId: call.id }, 202);
    const unknown = () => c.json({ error: "outcome_unknown", callId: call.id }, 409);
    const context = {
      kind: "task" as const,
      id: capability.taskId,
      conversationId: binding.conversationId,
    };
    let approvalId: string | undefined;
    let executeInput = input;
    if (call.status === "new") {
      if (!canPrepare) return c.json({ error: "invalid_input" }, 400);
      if (!(await store.transition(call, "new", "preparing"))) {
        call = (await store.load(call.id)) ?? call;
        return call.status === "completed"
          ? replay()
          : call.status === "pending"
            ? waiting()
            : unknown();
      }
      call = { ...call, status: "preparing" };
      if (policy.outcome === "ask") {
        const item: PendingItem = {
          approvalId: `appr_${call.id}`,
          toolCallId: call.id,
          tool: body.tool,
          args,
          ...(target === undefined ? {} : { target }),
          risk: policy.risk,
          rule: policy.rule,
          taint: { kind: "tool", label: `Computer ${capability.computerId}` },
          scopes: policy.scopes,
          stepUp: policy.stepUp,
          expiresAt: Math.min(Date.now() + APPROVAL_TTL_MS, capability.expiresAt),
        };
        const rows = await bindBatch({
          userId: capability.userId,
          tools: composed.tools,
          context,
          pending: { batchId, items: [item] },
        });
        if (!(await user.approvals.create(rows))) return unknown();
        if (!(await store.transition(call, "preparing", "pending"))) return unknown();
        try {
          await (user.assistant() as unknown as GatewayApprovalNotifier).gatewayApprovalChanged(
            batchId,
          );
        } catch {
          // The card is durable; retries still share it if its live notification is lost.
        }
        return waiting();
      }
    } else if (call.status === "preparing") {
      return unknown();
    } else if (call.status === "executing") {
      return unknown(); // A crash after dispatch is never permission to run the side effect again.
    }
    let refusal: string | undefined = policy.outcome === "deny" ? policy.rule : undefined;
    if (call.status === "pending") {
      const rows = await user.approvals.batch(batchId);
      const row = rows[0];
      if (rows.length !== 1 || !row || row.toolCallId !== call.id) refusal = "approval_missing";
      else {
        approvalId = row.approvalId;
        if (row.status === "pending" && row.expiresAt > Date.now() && !refusal) return waiting();
        if (row.status !== "approved" || row.expiresAt <= Date.now())
          refusal = refusal ?? "approval_denied";
        else {
          refusal =
            refusal ??
            (await bindingProblem(row, {
              userId: capability.userId,
              context,
              tools: composed.tools,
            })) ??
            undefined;
          const envelope = await openApproval(row.canonical, row.bindingHash);
          if (!envelope || canonical(envelope.args) !== canonical(input))
            refusal = "binding_mismatch";
          else executeInput = envelope.args;
        }
      }
    }
    if (!(await store.transition(call, call.status, "executing"))) {
      call = (await store.load(call.id)) ?? call;
      return call.status === "completed" ? replay() : unknown();
    }
    const finish = async (status: number, response: unknown) => {
      await store.finish(call, status, response);
      call = (await store.load(call.id)) ?? call;
      return replay();
    };
    if (refusal) {
      if (approvalId)
        await user.approvals.finish(batchId, approvalId, { status: "denied", reason: refusal });
      return finish(403, { error: "tool_denied" });
    }
    if (
      approvalId &&
      (!(await user.approvals.claim(batchId, approvalId, Date.now())) ||
        !(await user.approvals.dispatch(batchId, approvalId)))
    )
      return finish(403, { error: "approval_unavailable" });
    try {
      let result: Awaited<ReturnType<typeof entry.tool.execute>>;
      try {
        result = await entry.tool.execute(executeInput, AbortSignal.timeout(30_000), {
          toolCallId: call.id,
          approved: approvalId !== undefined,
        });
      } catch {
        if (approvalId)
          await user.approvals.finish(batchId, approvalId, { status: "failed" }).catch(() => {});
        return await finish(500, { error: "tool_failed" });
      }
      if (approvalId)
        await user.approvals.finish(batchId, approvalId, {
          status: result.ok ? "executed" : "failed",
        });
      const bytes = new TextEncoder().encode(result.content);
      const response = {
        ok: result.ok,
        content: new TextDecoder().decode(bytes.subarray(0, 64 * 1024)),
        truncated: bytes.length > 64 * 1024,
        taint: "untrusted",
      };
      // Store the outcome before delivery/notification; a lost response never reruns the tool.
      await store.finish(call, 200, response);
      try {
        if (result.ok && result.artifact)
          await (user.assistant() as unknown as ArtifactNotifier).artifactCreated(
            result.artifact.artifactId,
          );
      } catch {
        // Notification cannot change the durably saved tool outcome.
      }
      call = (await store.load(call.id)) ?? call;
      return replay();
    } catch {
      // A post-dispatch bookkeeping failure is not evidence that the tool failed.
      return unknown();
    } finally {
      await entry.tool.dispose?.().catch(() => {});
    }
  },
);

capabilityAudiences.post("/tasks/:taskId/artifacts", async (c) => {
  const capability = c.var.capability;
  if (!capability || c.req.param("taskId") !== capability.taskId)
    return c.json({ error: "unauthenticated" }, 401);
  c.header("Cache-Control", "no-store");
  const repository = createRepository(c.env);
  const binding = await repository.scopeForCapability(capability);
  if (!binding) return c.json({ error: "unauthenticated" }, 401);
  let upload: Awaited<ReturnType<typeof readAttachment>> | undefined;
  try {
    const maxBytes = attachmentMaxBytes(c.env);
    if (Number(c.req.header("content-length")) > maxBytes) throw new UploadError(413, "too_large");
    const id = crypto.randomUUID();
    const store = repository.capabilityArtifact(capability, maxBytes);
    if (!(await store.reserve(id))) throw new UploadError(429, "upload_quota");
    upload = await readAttachment(
      c.req.raw.body,
      fileName(c.req.header("x-file-name")),
      maxBytes,
      async (bytes) => {
        if (!(await store.charge(id, bytes))) throw new UploadError(429, "upload_quota");
      },
    );
    const published = await store.put({
      id,
      name: upload.name,
      mediaType: upload.mediaType,
      body: upload.stream,
      sizeBytes: upload.sizeBytes,
    });
    if (!published) return c.json({ error: "unauthenticated" }, 401);
    try {
      const notifier = repository.forUser(binding.scope).assistant() as unknown as ArtifactNotifier;
      await notifier.artifactCreated(id);
    } catch {
      // Publication succeeded: a missed live notification must not invite a duplicate upload.
    }
    return c.json(
      { id, name: upload.name, mediaType: upload.mediaType, sizeBytes: upload.sizeBytes() },
      201,
    );
  } catch (error) {
    const failure = upload?.failure() ?? error;
    if (failure instanceof UploadError) return c.json({ error: failure.code }, failure.status);
    throw error;
  }
});
