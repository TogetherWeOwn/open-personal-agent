// SPDX-License-Identifier: Apache-2.0
// Settings › Privacy & security (M3-19 AC2, m3-ux §3.9): passkeys (add, rename, remove with
// step-up), recovery codes (regenerate with step-up, shown once), sessions (list, revoke, sign
// out everywhere) and Approvals (the policy, active grants with Revoke). Removing a passkey or
// signing out everywhere expires anything waiting on approval, and the confirmations say so
// (M3-07 AC13).
import {
  type PublicKeyCredentialCreationOptionsJSON,
  startRegistration,
} from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { Heading, Input, Label, Link, TextField } from "react-aria-components";
import { cancelled } from "../auth/ui";
import { dayOf, settingsApi } from "../models/settings-api";
import { Button } from "../ui";
import {
  type GrantRow,
  grantScopeLabel,
  type PasskeyRow,
  privacyError,
  REGENERATE_CODES_CONFIRM,
  removePasskeyConfirm,
  type SessionRow,
  SIGN_OUT_EVERYWHERE_CONFIRM,
} from "./privacy-copy";
import { withAccountStepUp } from "./step-up";

const card = "flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4";
const hint = "text-sm text-text-muted";
const errorText = "text-sm text-danger";
const rowButtons = "flex flex-wrap gap-2";
const input = "min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2";

/** JSON over `/api` (not `/api/settings`): rejects with the server's error code. */
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const displayName = (p: PasskeyRow) => p.name ?? "Unnamed passkey";

export function PrivacySecurity() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [grants, setGrants] = useState<GrantRow[] | null>(null);
  const [grantsError, setGrantsError] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);

  /** Standing approvals load on their own, with their own retry: a grants failure must not blank the page. */
  const loadGrants = async () => {
    setGrantsError(false);
    try {
      const standing = await settingsApi<{ grants: GrantRow[] }>("/grants");
      setGrants(standing.grants);
    } catch {
      setGrantsError(true);
    }
  };

  const load = async () => {
    setLoadError(false);
    setError(null);
    try {
      const [keys, sess, codes] = await Promise.all([
        api<{ passkeys: PasskeyRow[] }>("/passkeys"),
        api<{ sessions: SessionRow[] }>("/sessions"),
        api<{ remaining: number }>("/recovery-codes"),
      ]);
      setPasskeys(keys.passkeys);
      setSessions(sess.sessions);
      setRemaining(codes.remaining);
    } catch {
      setLoadError(true);
    }
    await loadGrants();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once, like AppsTools.
  useEffect(() => {
    let live = true;
    void load().catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
  }, []);

  const reloadLists = () =>
    Promise.all([
      api<{ passkeys: PasskeyRow[] }>("/passkeys"),
      api<{ sessions: SessionRow[] }>("/sessions"),
    ])
      .then(([keys, sess]) => {
        setPasskeys(keys.passkeys);
        setSessions(sess.sessions);
      })
      .catch(() => {});

  const run = async (key: string, fn: () => Promise<void>) => {
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      await withAccountStepUp(fn);
    } catch (e) {
      if ((e as Error).message === "not_found") {
        // The copy says the list was refreshed: make it true before reporting it.
        await reloadLists();
        await loadGrants();
        setError(privacyError(e));
      } else if (cancelled(e)) {
        // A dismissed passkey prompt rejects here. Only adding promises a passkey; every
        // other action leaves everything untouched (m3-ux §3.9).
        setError(key === "add" ? "No passkey was created." : "Not confirmed. Nothing was done.");
      } else {
        setError(privacyError(e));
      }
    } finally {
      setPending(null);
    }
  };

  const reloadKeys = () =>
    api<{ passkeys: PasskeyRow[] }>("/passkeys").then(({ passkeys }) => setPasskeys(passkeys));

  if (loadError || passkeys === null || sessions === null || remaining === null)
    return (
      <section aria-labelledby="privacy-heading" className="flex flex-col gap-4">
        <Heading level={2} id="privacy-heading" className="text-xl font-semibold">
          Privacy & security
        </Heading>
        {loadError ? (
          <>
            <p role="alert" className={errorText}>
              I couldn’t load this page.
            </p>
            <div className={rowButtons}>
              <Button onPress={() => void load()} variant="secondary">
                Try again
              </Button>
            </div>
          </>
        ) : (
          <p className={hint}>Loading…</p>
        )}
      </section>
    );

  // The server refuses the last passkey too; the page says so first.
  const onlyKey = passkeys.length <= 1;

  return (
    <section aria-labelledby="privacy-heading" className="flex flex-col gap-6">
      <Heading level={2} id="privacy-heading" className="text-xl font-semibold">
        Privacy & security
      </Heading>
      {error && (
        <p role="alert" className={errorText}>
          {error}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <Heading level={3} className="text-lg font-semibold">
          Passkeys
        </Heading>
        <ul className="flex flex-col gap-3">
          {passkeys.map((p) => (
            <li key={p.id} className={card}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold">{displayName(p)}</p>
                <p className={hint}>
                  Added {dayOf(p.createdAt)}
                  {p.lastUsedAt ? ` · last used ${dayOf(p.lastUsedAt)}` : ""}
                </p>
              </div>
              {renaming === p.id ? (
                <TextField
                  value={nameDraft}
                  onChange={setNameDraft}
                  className="flex flex-col gap-1"
                >
                  <Label className={hint}>Name this passkey</Label>
                  <Input className={input} maxLength={64} />
                </TextField>
              ) : confirmRemove === p.id ? (
                <p className={hint}>{removePasskeyConfirm(displayName(p))}</p>
              ) : null}
              <div className={rowButtons}>
                {renaming === p.id ? (
                  <>
                    <Button
                      variant="primary"
                      isDisabled={pending === `rename:${p.id}`}
                      onPress={() =>
                        void run(`rename:${p.id}`, async () => {
                          const { passkey } = await api<{ passkey: { id: string; name: string } }>(
                            `/passkeys/${p.id}`,
                            "PATCH",
                            { name: nameDraft },
                          );
                          setPasskeys(
                            (prev) =>
                              prev?.map((k) =>
                                k.id === p.id ? { ...k, name: passkey.name } : k,
                              ) ?? null,
                          );
                          setRenaming(null);
                        })
                      }
                    >
                      Save name
                    </Button>
                    <Button
                      variant="secondary"
                      isDisabled={pending === `rename:${p.id}`}
                      onPress={() => setRenaming(null)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : confirmRemove === p.id ? (
                  <>
                    <Button
                      variant="danger"
                      isDisabled={pending === `remove:${p.id}`}
                      onPress={() =>
                        void run(`remove:${p.id}`, async () => {
                          await api(`/passkeys/${p.id}`, "DELETE");
                          setConfirmRemove(null);
                          await reloadKeys();
                        })
                      }
                    >
                      Remove it
                    </Button>
                    <Button
                      variant="secondary"
                      isDisabled={pending === `remove:${p.id}`}
                      onPress={() => setConfirmRemove(null)}
                    >
                      Keep it
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      isDisabled={pending !== null}
                      aria-label={`Rename ${displayName(p)}`}
                      onPress={() => {
                        setNameDraft(p.name ?? "");
                        setRenaming(p.id);
                      }}
                    >
                      Rename
                    </Button>
                    <Button
                      variant="secondary"
                      isDisabled={pending !== null || onlyKey}
                      aria-label={`Remove ${displayName(p)}`}
                      onPress={() => setConfirmRemove(p.id)}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        {onlyKey && (
          <p className={hint}>Your only passkey — add another before removing this one.</p>
        )}
        <div className={rowButtons}>
          <Button
            variant="secondary"
            isDisabled={pending !== null}
            onPress={() =>
              void run("add", async () => {
                const { options } = await api<{
                  options: PublicKeyCredentialCreationOptionsJSON;
                }>("/passkeys/options", "POST", {});
                const credential = await startRegistration({ optionsJSON: options });
                await api("/passkeys", "POST", { credential });
                await reloadKeys();
              })
            }
          >
            {pending === "add" ? "Waiting for your device…" : "Add a passkey"}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Heading level={3} className="text-lg font-semibold">
          Recovery codes
        </Heading>
        {freshCodes ? (
          <div className={card}>
            <p>
              Save these now — <strong>they won’t be shown again.</strong> Each code works once.
            </p>
            <ol
              aria-label="New recovery codes"
              className="grid gap-1 rounded-lg bg-surface-sunken p-4 font-mono sm:grid-cols-2"
            >
              {freshCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ol>
            <div className={rowButtons}>
              <Button variant="primary" onPress={() => setFreshCodes(null)}>
                I’ve saved them
              </Button>
            </div>
          </div>
        ) : (
          <div className={card}>
            <p className={hint}>
              {remaining === 0
                ? "Every code is used up — replace them now."
                : remaining <= 2
                  ? `Only ${remaining} unused ${remaining === 1 ? "code" : "codes"} left — replace them soon.`
                  : `${remaining} unused codes.`}{" "}
              If you lose your passkey, a code gets you back in.
            </p>
            {confirmRegen && <p className={hint}>{REGENERATE_CODES_CONFIRM}</p>}
            <div className={rowButtons}>
              {confirmRegen ? (
                <>
                  <Button
                    variant="danger"
                    isDisabled={pending === "regen"}
                    onPress={() =>
                      void run("regen", async () => {
                        const { codes } = await api<{ codes: string[] }>(
                          "/recovery-codes/regenerate",
                          "POST",
                          {},
                        );
                        setConfirmRegen(false);
                        setFreshCodes(codes);
                        const { remaining } = await api<{ remaining: number }>("/recovery-codes");
                        setRemaining(remaining);
                      })
                    }
                  >
                    Replace them
                  </Button>
                  <Button
                    variant="secondary"
                    isDisabled={pending === "regen"}
                    onPress={() => setConfirmRegen(false)}
                  >
                    Keep mine
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  isDisabled={pending !== null}
                  onPress={() => setConfirmRegen(true)}
                >
                  Replace my codes
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <Heading level={3} className="text-lg font-semibold">
          Sessions
        </Heading>
        <ul className="flex flex-col gap-3">
          {sessions.map((s) => (
            <li key={s.id} className={card}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold">{s.current ? "This session" : "Another session"}</p>
                <p className={hint}>
                  Signed in {dayOf(s.createdAt)} · last seen {dayOf(s.lastSeenAt)}
                </p>
              </div>
              {!s.current && (
                <div className={rowButtons}>
                  <Button
                    variant="secondary"
                    isDisabled={pending !== null}
                    aria-label={`Revoke the session last seen ${dayOf(s.lastSeenAt)}`}
                    onPress={() =>
                      void run(`revoke:${s.id}`, async () => {
                        await api(`/sessions/${s.id}`, "DELETE");
                        setSessions((prev) => prev?.filter((row) => row.id !== s.id) ?? null);
                      })
                    }
                  >
                    Revoke
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className={card}>
          {confirmSignOut ? (
            <>
              <p className={hint}>{SIGN_OUT_EVERYWHERE_CONFIRM}</p>
              <div className={rowButtons}>
                <Button
                  variant="danger"
                  isDisabled={pending === "revoke-all"}
                  onPress={() =>
                    void run("revoke-all", async () => {
                      await api("/sessions/revoke-all", "POST", {});
                      // The cookie is gone with the session: the signed-out screen follows.
                      window.location.assign("/");
                    })
                  }
                >
                  Sign out everywhere
                </Button>
                <Button
                  variant="secondary"
                  isDisabled={pending === "revoke-all"}
                  onPress={() => setConfirmSignOut(false)}
                >
                  Stay signed in
                </Button>
              </div>
            </>
          ) : (
            <div className={rowButtons}>
              <Button
                variant="secondary"
                isDisabled={pending !== null}
                onPress={() => setConfirmSignOut(true)}
              >
                Sign out everywhere
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Heading level={3} className="text-lg font-semibold">
          Approvals
        </Heading>
        <div className={card}>
          <p>
            Consequential actions ask you first. When you approve one, you can let it through just
            this once — or stand the approval, so the same call skips the question next time.
          </p>
          <p className={hint}>
            Each tool asks the way its risk class says it should; a tool that can’t be undone always
            asks first. Set a tool to never run, or let it run without asking, in{" "}
            <Link
              href="/settings/apps"
              className="font-medium text-accent underline underline-offset-2"
            >
              Apps &amp; tools
            </Link>
            .
          </p>
        </div>
        {grantsError ? (
          <div className={card}>
            <p role="alert" className={errorText}>
              I couldn’t load your standing approvals.
            </p>
            <div className={rowButtons}>
              <Button onPress={() => void loadGrants()} variant="secondary">
                Try again
              </Button>
            </div>
          </div>
        ) : grants === null ? (
          <p className={hint}>Loading…</p>
        ) : grants.length === 0 ? (
          <p className={hint}>No standing approvals. Every consequential action will ask you.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {grants.map((g) => (
              <li key={g.id} className={card}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-semibold">
                    <code>{g.tool}</code>
                  </p>
                  <p className={hint}>
                    {grantScopeLabel(g)} · standing since {dayOf(g.createdAt)}
                  </p>
                </div>
                <div className={rowButtons}>
                  <Button
                    variant="secondary"
                    isDisabled={pending !== null}
                    aria-label={`Revoke the ${g.tool} approval`}
                    onPress={() =>
                      void run(`ungrant:${g.id}`, async () => {
                        await settingsApi(`/grants/${g.id}`, "DELETE");
                        setGrants((prev) => prev?.filter((row) => row.id !== g.id) ?? null);
                      })
                    }
                  >
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
