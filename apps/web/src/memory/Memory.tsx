// SPDX-License-Identifier: Apache-2.0
// Memory (m3-ux §3.7, M3-15): what the assistant remembers, in sections — About you (standing
// instructions) and Notes — with search, Edit (saved as a new version) and Add.

import { Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Checkbox,
  Heading,
  Input,
  Label,
  SearchField,
  TextArea,
  TextField,
} from "react-aria-components";
import { Banner, Button, EmptyState, Page, Skeleton } from "../ui";
import { addNote, listNotes, memoryError, type Note, SEARCH_LIMIT } from "./api";
import { NoteRow } from "./NoteRow";

export function Memory() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [draft, setDraft] = useState("");
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
    const timer = setTimeout(() => load(query.trim()), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

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

  const row = (note: Note) => (
    <NoteRow
      key={keys.current.get(note.id) ?? note.id}
      note={note}
      onSaved={(next) => saved(note, next)}
      onStale={stale}
    />
  );

  const all = notes ?? [];
  const instructions = all.filter((n) => n.kind === "instruction");
  const facts = all.filter((n) => n.kind === "fact");
  return (
    <Page title="Memory">
      <p role="status" className="sr-only">
        {announcement}
      </p>
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
            </div>
            {facts.length > 0 ? (
              <ul className="flex flex-col gap-2">{facts.map(row)}</ul>
            ) : (
              <p className="text-text-muted">No notes yet.</p>
            )}
          </section>
        </>
      )}
      {!shown && notes !== null && (
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
    </Page>
  );
}
