// SPDX-License-Identifier: Apache-2.0
// Memory (m3-ux §3.7, M3-15): what the assistant remembers, in sections — Waiting for you,
// Recently learned, About you (standing instructions) and Notes — with search, Edit, Delete, bulk
// delete and Export.
//
// Every delete says a backup is kept for 30 days (AC3). A delete is held while its Undo toast is
// open and sent when the toast closes, the screen goes away or the page unloads, so the server's
// forget stays a true hard delete and Undo never needs a restore.
import { Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Checkbox,
  Heading,
  Input,
  Label,
  Link,
  SearchField,
  TextArea,
  TextField,
} from "react-aria-components";
import {
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  Menu,
  MenuItem,
  Page,
  Skeleton,
  Toast,
} from "../ui";
import {
  addNote,
  BACKUP_LINE,
  downloadExport,
  exportError,
  learnSetting,
  listNotes,
  memoryError,
  type Note,
  SEARCH_LIMIT,
} from "./api";
import { Knows } from "./Knows";
import { NoteMeta, NoteRow } from "./NoteRow";
import { Waiting } from "./Waiting";

const WEEK = 7 * 86_400_000;
const RECENT = 5;

const quote = (text: string) => `'${text.length > 60 ? `${text.slice(0, 57)}…` : text}'`;

interface Held {
  ids: string[];
  message: string;
  /** From the selection: a failure puts the notes back in it. */
  bulk: boolean;
}

/** The most IDs one delete request takes (the server's limit). */
const BATCH = 1000;
/** What browsers let keepalive requests carry in flight at once (64 KiB), with some to spare. */
const KEEPALIVE_BYTES = 60_000;

/**
 * Sends a delete in batches the server accepts, all started at once so a page that is going away
 * still sends every one. Each goes with `keepalive` while the browser's allowance lasts, so it
 * finishes if the page unloads. Returns the IDs that weren't deleted and whether any batch failed
 * outright; a failed batch never hides what the others deleted.
 */
async function send(ids: string[]) {
  let allowance = KEEPALIVE_BYTES;
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const body = JSON.stringify({ ids: batch });
      const keepalive = body.length <= allowance;
      if (keepalive) allowance -= body.length;
      const res = await fetch("/api/memory/delete", {
        method: "POST",
        keepalive,
        headers: { "content-type": "application/json" },
        body,
      });
      if (!res.ok) throw new Error(String(res.status));
      return ((await res.json()) as { failed: string[] }).failed;
    }),
  );
  const missed = results.flatMap((r, i) =>
    r.status === "fulfilled" ? r.value : (batches[i] ?? []),
  );
  return { missed, offline: results.some((r) => r.status === "rejected") };
}

/** "'A', 'B' and 3 more": a few names, then a count. */
function names(texts: string[]) {
  const shown = texts.slice(0, 3).map(quote).join(", ");
  return texts.length > 3 ? `${shown} and ${texts.length - 3} more` : shown;
}

export function Memory() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState("");
  const [held, setHeld] = useState<Held | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [allRecent, setAllRecent] = useState(false);
  const [draft, setDraft] = useState("");
  // Whether "Learn from our chats" is on; null when the setting couldn't be read.
  const [learning, setLearning] = useState<boolean | null>(true);
  const [knows, setKnows] = useState(false);
  const [standing, setStanding] = useState(false);
  // A saved edit gets a new id; its row keeps the old key so focus stays on it.
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async (q: string) => {
    try {
      const loaded = await listNotes(q);
      setNotes(loaded);
      setShown(q);
      setFailed(false);
      return loaded;
    } catch {
      setFailed(true);
      return null;
    }
  }, []);
  useEffect(() => {
    learnSetting().then(setLearning, () => setLearning(null));
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => load(query.trim()), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  // The held delete goes out when the toast closes, and also if the screen or page goes away.
  // The toast closes with it, so a page restored from the back/forward cache can't send it twice;
  // the restored page asks the server again, so a delete that failed on the way out shows.
  const heldRef = useRef<Held | null>(null);
  heldRef.current = held;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    const flush = () => {
      const h = heldRef.current;
      if (!h) return;
      heldRef.current = null;
      void send(h.ids);
      setHeld(null);
      setNotes((all) => all?.filter((n) => !h.ids.includes(n.id)) ?? null);
    };
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) void load(shownRef.current);
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("pageshow", restored);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("pageshow", restored);
      flush();
    };
  }, [load]);

  const commit = async (h: Held) => {
    setHeld(null);
    heldRef.current = null;
    const { missed, offline } = await send(h.ids);
    setNotes((all) => all?.filter((n) => !h.ids.includes(n.id) || missed.includes(n.id)) ?? null);
    if (missed.length === 0) return;
    const none = offline && missed.length === h.ids.length;
    const kept = (notes ?? []).filter((n) => missed.includes(n.id)).map((n) => n.text);
    setProblem(
      none
        ? "I couldn't delete that. Check your connection and try again."
        : `Deleted ${h.ids.length - missed.length} of ${h.ids.length}. I couldn't delete ${names(kept)}.`,
    );
    if (h.bulk || !none) {
      setSelected(new Set(missed));
      setSelecting(true);
    }
  };

  /** Holds the delete behind an Undo toast; a delete already held goes out first. */
  const hold = (ids: string[], message: string, bulk = false) => {
    if (heldRef.current) commit(heldRef.current);
    setProblem(null);
    setHeld({ ids, message, bulk });
    setAnnouncement(message);
    setSelecting(false);
    setSelected(new Set());
  };

  const saved = (old: Note, next: Note) => {
    keys.current.set(next.id, keys.current.get(old.id) ?? old.id);
    setNotes((all) => all?.map((n) => (n.id === old.id ? next : n)) ?? null);
    setProblem(null);
    setAnnouncement("Saved.");
    // The new text may not match the search any more: ask the server again.
    if (shown) {
      void load(shown).then((found) => {
        if (found && !found.some((n) => n.id === next.id)) {
          setAnnouncement("Saved. It no longer matches your search.");
        }
      });
    }
  };

  // Esc leaves selection mode wherever focus is, a note's checkbox included; the dialog has its own.
  useEffect(() => {
    if (!selecting || confirming) return;
    const leave = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setSelecting(false);
      setSelected(new Set());
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [selecting, confirming]);

  const stale = (message: string) => {
    setProblem(message);
    void load(shown);
  };

  const add = async () => {
    try {
      const note = await addNote(draft, standing ? "instruction" : "fact");
      setNotes((all) => [note, ...(all ?? [])]);
      setDraft("");
      setStanding(false);
      setProblem(null);
      setAnnouncement("Added.");
    } catch (e) {
      setProblem(memoryError(e));
    }
  };

  const deleting = new Set(held?.ids ?? []);
  const row = (note: Note) => (
    <NoteRow
      key={keys.current.get(note.id) ?? note.id}
      note={note}
      deleting={deleting.has(note.id)}
      selecting={selecting}
      selected={selected.has(note.id)}
      onSelect={(on) => {
        const next = new Set(selected);
        if (on) next.add(note.id);
        else next.delete(note.id);
        setSelected(next);
        setAnnouncement(`${selectable.filter((n) => next.has(n.id)).length} selected`);
      }}
      onSaved={(next) => saved(note, next)}
      onDelete={() => hold([note.id], `Deleted ${quote(note.text)}. ${BACKUP_LINE}`)}
      onStale={stale}
    />
  );

  const all = notes ?? [];
  const instructions = all.filter((n) => n.kind === "instruction");
  const facts = all.filter((n) => n.kind === "fact");
  const recent = shown
    ? []
    : all.filter((n) => Date.now() - n.createdAt < WEEK && n.trust !== "system");
  // Only notes on screen count: a search can hide selected ones, and held ones are on their way out.
  const selectable = all.filter((n) => !deleting.has(n.id));
  const picked = selectable.filter((n) => selected.has(n.id));
  const pickedInstructions = picked.filter((n) => n.kind === "instruction").length;

  return (
    <Page title="Memory">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div className="-mt-4 flex justify-end">
        <Menu label="Export" variant="secondary">
          <MenuItem onAction={() => setKnows(true)}>View what my assistant knows about me</MenuItem>
          <MenuItem
            onAction={() => {
              setProblem(null);
              downloadExport().catch((e) => setProblem(exportError(e)));
            }}
          >
            Download JSON
          </MenuItem>
        </Menu>
      </div>
      {learning !== true && (
        <Banner>
          {learning === false
            ? "I'm not saving new memories."
            : "I couldn't check whether I'm saving new memories."}{" "}
          <Link href="/settings/memory" className="font-medium text-accent underline">
            {learning === false ? "Turn this on in Settings." : "Check in Settings."}
          </Link>
        </Banner>
      )}
      <Knows isOpen={knows} onOpenChange={setKnows} />
      {!shown && <Waiting onDecided={() => load(query.trim())} />}
      <SearchField value={query} onChange={setQuery} className="flex flex-col gap-1">
        <Label className="text-sm font-medium">Search notes</Label>
        <Input className="min-h-11 rounded-lg border border-border-strong bg-surface px-3" />
      </SearchField>
      {problem && (
        <Banner tone="danger" alert>
          {problem}
        </Banner>
      )}
      {failed ? (
        <EmptyState
          title="I couldn't load your memory."
          action={<Button onPress={() => load(query.trim())}>Try again</Button>}
        />
      ) : notes === null ? (
        <Skeleton label="Loading your memory" />
      ) : all.length === 0 && shown ? (
        <EmptyState
          title={`Nothing matches "${shown}".`}
          action={<Button onPress={() => setQuery("")}>Clear search</Button>}
        />
      ) : all.length === 0 ? (
        <EmptyState title="I'll remember things you tell me, like your preferences and ongoing projects.">
          You can always see and change them here.
        </EmptyState>
      ) : (
        <>
          {shown && all.length >= SEARCH_LIMIT && (
            <p className="text-sm text-text-muted">
              Showing the first {SEARCH_LIMIT} matches. Add a word to narrow it.
            </p>
          )}
          {recent.length > 0 && (
            <section aria-labelledby="recent" className="flex flex-col gap-3">
              <Heading id="recent" level={2} className="text-lg font-semibold">
                Recently learned
              </Heading>
              <ul className="flex flex-col gap-2">
                {recent.slice(0, allRecent ? undefined : RECENT).map((n) => (
                  <li
                    key={n.id}
                    className={`flex flex-wrap items-start justify-between gap-2 rounded-xl border border-border p-3 ${deleting.has(n.id) ? "opacity-60" : ""}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="break-words">{n.text}</p>
                      <NoteMeta note={n} verb="Learned" />
                    </div>
                    {!deleting.has(n.id) && (
                      <Button
                        variant="quiet"
                        aria-label={`Undo: ${n.text}`}
                        onPress={() => hold([n.id], `Forgot ${quote(n.text)}. ${BACKUP_LINE}`)}
                      >
                        Undo
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {recent.length > RECENT && !allRecent && (
                <Button variant="quiet" className="self-start" onPress={() => setAllRecent(true)}>
                  Show all {recent.length}
                </Button>
              )}
            </section>
          )}
          {instructions.length > 0 && (
            <section aria-labelledby="about" className="flex flex-col gap-3">
              <Heading id="about" level={2} className="text-lg font-semibold">
                About you
              </Heading>
              <p className="text-sm text-text-muted">
                Standing instructions. Only you can add or change these.
              </p>
              <ul className="flex flex-col gap-2">{instructions.map(row)}</ul>
            </section>
          )}
          <section aria-labelledby="notes" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Heading id="notes" level={2} className="text-lg font-semibold">
                Notes
              </Heading>
              {!selecting && (
                <Button variant="quiet" onPress={() => setSelecting(true)}>
                  Select
                </Button>
              )}
            </div>
            {facts.length > 0 ? (
              <ul className="flex flex-col gap-2">{facts.map(row)}</ul>
            ) : (
              <p className="text-text-muted">No notes yet.</p>
            )}
          </section>
        </>
      )}
      {!shown && notes !== null && !selecting && (
        <TextField
          value={draft}
          onChange={setDraft}
          maxLength={2000}
          className="flex flex-col gap-1"
        >
          <Label className="font-medium">Add a note</Label>
          <TextArea rows={2} className="rounded-lg border border-border-strong bg-surface p-2" />
          <Checkbox
            isSelected={standing}
            onChange={setStanding}
            className="group flex min-h-11 items-center gap-2"
          >
            <span className="flex size-5 items-center justify-center rounded border border-border-strong group-data-selected:bg-accent group-data-selected:text-accent-contrast group-data-focus-visible:outline-2 group-data-focus-visible:outline-focus-ring">
              {standing && <Check aria-hidden="true" size={14} />}
            </span>
            Make it a standing instruction
          </Checkbox>
          <Button className="mt-1 self-start" onPress={add} isDisabled={draft.trim() === ""}>
            Add
          </Button>
        </TextField>
      )}
      {selecting && (
        <section
          aria-label="Selection"
          className="sticky bottom-20 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-border-strong bg-surface-raised p-3 shadow-lg sm:bottom-4"
        >
          <p className="flex-1">{picked.length} selected</p>
          <Button onPress={() => setSelected(new Set(selectable.map((n) => n.id)))}>
            Select all {selectable.length}
          </Button>
          <Button
            variant="danger"
            isDisabled={picked.length === 0}
            onPress={() => setConfirming(true)}
          >
            Delete…
          </Button>
          <Button
            variant="quiet"
            onPress={() => {
              setSelecting(false);
              setSelected(new Set());
            }}
          >
            Cancel
          </Button>
        </section>
      )}
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${picked.length} ${picked.length === 1 ? "note" : "notes"}?`}
        confirm="Delete"
        danger
        onConfirm={() =>
          hold(
            picked.map((n) => n.id),
            `Deleted ${picked.length} ${picked.length === 1 ? "note" : "notes"}. ${BACKUP_LINE}`,
            true,
          )
        }
      >
        <p>{BACKUP_LINE}</p>
        {pickedInstructions > 0 && (
          <p>
            This includes {pickedInstructions} standing{" "}
            {pickedInstructions === 1 ? "instruction" : "instructions"}.
          </p>
        )}
      </ConfirmDialog>
      {held && (
        <Toast
          key={held.ids.join()}
          action="Undo"
          onAction={() => {
            setHeld(null);
            heldRef.current = null;
            setAnnouncement("Undone. Nothing was deleted.");
          }}
          onClose={() => commit(held)}
        >
          {held.message}
        </Toast>
      )}
    </Page>
  );
}
