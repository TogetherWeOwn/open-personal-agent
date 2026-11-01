// SPDX-License-Identifier: Apache-2.0
// Waiting for you (m3-ux §3.7, Flow C; M3-15 AC2): things the assistant would like to remember,
// change or forget, each with its source, a diff when it changes a note, and when it expires.
// Nothing is applied until the user picks; an unanswered suggestion expires to rejected. The
// same list will show in Inbox › Memories to confirm.
import { useCallback, useEffect, useRef, useState } from "react";
import { Heading } from "react-aria-components";
import { Banner, Button, Card, Toast, TrustChip } from "../ui";
import { type Decision, decide, expiresIn, listProposals, memoryError, type Proposal } from "./api";
import { MemoryDiff } from "./MemoryDiff";
import { NoteMeta } from "./NoteRow";

/**
 * A change whose notes were edited or deleted since: the list sends no targets for it, and
 * accepting it would fail, so it can only be kept as a note of its own or dismissed.
 */
const orphaned = (p: Proposal) => p.op !== "create" && p.targets.length === 0;

/** The choices for each kind of suggestion, the accepting one first. */
function choices(p: Proposal): [Decision, string][] {
  if (p.op === "delete") {
    return orphaned(p)
      ? [["reject", "Dismiss"]]
      : [
          ["accept", "Forget it"],
          ["reject", "Keep it"],
        ];
  }
  if (orphaned(p)) {
    return [
      ["keep-both", "Remember this"],
      ["reject", "Don't remember"],
    ];
  }
  if (p.targets.length > 0) {
    return [
      ["accept", "Use the new one"],
      ["reject", "Keep mine"],
      ["keep-both", "Keep both"],
    ];
  }
  return [
    ["accept", "Remember this"],
    ["reject", "Don't remember"],
  ];
}

function Suggestion({ p, onDecide }: { p: Proposal; onDecide: (d: Decision) => void }) {
  const heading = `proposal-${p.id}`;
  const forget = p.op === "delete";
  return (
    <li>
      <Card labelledBy={heading}>
        <Heading id={heading} level={3} className="break-words font-medium">
          {forget
            ? `Forget: ${p.targets.map((t) => t.text).join("; ")}`
            : `I'd like to remember: ${p.text}`}
        </Heading>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <TrustChip trust={p.trust} />
          <span className="text-sm font-medium">{expiresIn(p.expiresAt)}</span>
        </div>
        <NoteMeta note={p} verb="Suggested" />
        {p.sourceExcerpt && (
          <blockquote className="border-l-2 border-border-strong pl-3 text-sm text-text-muted">
            <span className="sr-only">From the source: </span>“{p.sourceExcerpt}”
          </blockquote>
        )}
        {orphaned(p) && (
          <p className="text-sm">
            {forget
              ? "The note this would forget was already changed or deleted."
              : "The note this would change was edited or deleted since."}
          </p>
        )}
        {!forget && p.targets.length > 0 && (
          <MemoryDiff before={p.targets.map((t) => t.text).join(" ")} after={p.text} />
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {choices(p).map(([decision, label], i) => (
            <Button
              key={decision}
              variant={i === 0 ? "primary" : "secondary"}
              onPress={() => onDecide(decision)}
            >
              {label}
            </Button>
          ))}
        </div>
      </Card>
    </li>
  );
}

export function Waiting({
  heading = true,
  onDecided,
}: {
  /** On the Memory screen the list is a section with its own heading; hidden when empty. */
  heading?: boolean;
  /** A suggestion was applied, so the notes changed. */
  onDecided?: () => void;
}) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // A discarded suggestion is held behind Undo for 10 s, as a delete is (Flow C1), and sent when
  // the toast closes or the screen or page goes away, so it doesn't come back somewhere else.
  const [discarded, setDiscarded] = useState<Proposal | null>(null);
  const discardedRef = useRef<Proposal | null>(null);
  discardedRef.current = discarded;
  useEffect(() => {
    const flush = () => {
      const p = discardedRef.current;
      if (!p) return;
      discardedRef.current = null;
      // Tried once more if it fails. If both fail, the suggestion waits again: nothing is
      // remembered, and it expires to rejected on its own.
      const reject = () =>
        fetch(`/api/memory/proposals/${p.id}/reject`, { method: "POST", keepalive: true });
      void (async () => {
        for (let tries = 0; tries < 2; tries++) {
          const res = await reject().catch(() => null);
          if (res && (res.ok || res.status === 404)) return;
        }
      })();
      setDiscarded(null);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  const load = useCallback(() => {
    listProposals().then(
      (r) => {
        setProposals(r.proposals);
        setLoadFailed(false);
        setProblem(null);
      },
      () => {
        setLoadFailed(true);
        setProblem("I couldn't load the suggestions waiting for you.");
      },
    );
  }, []);
  useEffect(load, [load]);

  const run = async (p: Proposal, decision: Decision) => {
    try {
      await decide(p.id, decision);
      if (decision !== "reject") onDecided?.();
    } catch (e) {
      setProblem(memoryError(e));
      load();
    }
  };

  const pick = (p: Proposal, decision: Decision) => {
    setProblem(null);
    setProposals((all) => all?.filter((x) => x.id !== p.id) ?? null);
    if (decision === "reject") {
      if (discarded) run(discarded, "reject");
      setDiscarded(p);
      setAnnouncement("Discarded. Nothing was remembered.");
      return;
    }
    setAnnouncement(decision === "keep-both" ? "Kept both." : "Done. Your notes are updated.");
    run(p, decision);
  };

  const list = proposals ?? [];
  if (heading && list.length === 0 && !discarded && !problem) {
    return (
      <p role="status" className="sr-only">
        {announcement}
      </p>
    );
  }
  return (
    <section aria-labelledby="waiting" className="flex flex-col gap-3">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {heading && (
        <Heading id="waiting" level={2} className="text-lg font-semibold">
          Waiting for you
        </Heading>
      )}
      {problem && (
        <Banner tone="danger" alert>
          {problem}
          {loadFailed && (
            <Button className="ml-2" onPress={load}>
              Try again
            </Button>
          )}
        </Banner>
      )}
      {!heading && proposals !== null && list.length === 0 && (
        <p id="waiting">
          Nothing is waiting for you. Suggestions I'd like to remember show up here.
        </p>
      )}
      {list.length > 0 && (
        <ul className="flex flex-col gap-3">
          {list.map((p) => (
            <Suggestion key={p.id} p={p} onDecide={(d) => pick(p, d)} />
          ))}
        </ul>
      )}
      {discarded && (
        <Toast
          key={discarded.id}
          action="Undo"
          onAction={() => {
            setProposals((all) => [discarded, ...(all ?? [])]);
            setDiscarded(null);
            discardedRef.current = null;
            setAnnouncement("Undone. The suggestion is back.");
          }}
          onClose={() => {
            run(discarded, "reject");
            setDiscarded(null);
            discardedRef.current = null;
          }}
        >
          {orphaned(discarded)
            ? "Dismissed."
            : discarded.op === "delete"
              ? `Kept “${discarded.targets.map((t) => t.text).join("; ")}”.`
              : `Discarded “${discarded.text}”.`}
        </Toast>
      )}
    </section>
  );
}
