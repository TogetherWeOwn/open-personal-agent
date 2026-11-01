// SPDX-License-Identifier: Apache-2.0
// One note on the Memory screen (m3-ux §3.7): its text, trust chip, source and dates, Edit in
// place (saved as a new version), Delete, and its earlier versions. In selection mode a checkbox
// replaces the actions.
import { Check, Lock } from "lucide-react";
import { useRef, useState } from "react";
import { Checkbox, Label, Link, TextArea, TextField } from "react-aria-components";
import { Button, Disclosure, TrustChip } from "../ui";
import { ago, editNote, memoryError, type Note, noteVersions, sourceLabel } from "./api";

const link = "font-medium text-accent underline underline-offset-2";

/** Where it came from and when, as one muted line. */
export function NoteMeta({ note, learned = false }: { note: Note; learned?: boolean }) {
  const href = note.conversation ? `/c/${note.conversation.id}` : null;
  const from = sourceLabel(note);
  return (
    <p className="text-sm text-text-muted">
      {learned ? `Learned ${ago(note.createdAt)}` : `Added ${ago(note.createdAt)}`}
      {" · "}
      {href ? (
        <Link href={href} className={link}>
          {from}
        </Link>
      ) : (
        from
      )}
      {note.sourceRef && /^https?:\/\//.test(note.sourceRef) && (
        <>
          {" · "}
          <a href={note.sourceRef} target="_blank" rel="noopener noreferrer" className={link}>
            {new URL(note.sourceRef).host}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </>
      )}
      {note.lastUsedAt !== null && ` · Last used ${ago(note.lastUsedAt)}`}
    </p>
  );
}

function EarlierVersions({ id }: { id: string }) {
  const [versions, setVersions] = useState<Note[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () => {
    if (versions) return;
    noteVersions(id).then(setVersions, () => setFailed(true));
  };
  return (
    <Disclosure summary="Earlier versions" onExpandedChange={(open) => open && load()}>
      {failed ? (
        <p className="text-sm">I couldn't load the earlier versions.</p>
      ) : !versions ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {versions.map((v) => (
            <li key={v.id} className="border-l-2 border-border pl-3">
              <p className="text-text-muted line-through">
                <span className="sr-only">Earlier: </span>
                {v.text}
              </p>
              <NoteMeta note={v} />
            </li>
          ))}
        </ol>
      )}
    </Disclosure>
  );
}

export function NoteRow({
  note,
  deleting,
  selecting,
  selected,
  onSelect,
  onSaved,
  onDelete,
}: {
  note: Note;
  /** Held in the Undo window: shown muted, with no actions. */
  deleting: boolean;
  selecting: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  /** The edit was saved as `next`, which replaces `note`. */
  onSaved: (next: Note) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const actions = useRef<HTMLDivElement>(null);
  const stopEditing = () => {
    setEditing(false);
    setError(null);
    // Back to the note's Edit button, so the keyboard user stays where they were.
    requestAnimationFrame(() => actions.current?.querySelector("button")?.focus());
  };
  const save = async () => {
    setSaving(true);
    try {
      onSaved(await editNote(note.id, draft));
      stopEditing();
    } catch (e) {
      setError(memoryError(e));
    } finally {
      setSaving(false);
    }
  };
  const instruction = note.kind === "instruction";
  const textId = `note-${note.id}`;
  return (
    <li
      className={`flex gap-2 rounded-xl border border-border bg-surface-raised p-4 ${deleting ? "opacity-60" : ""}`}
    >
      {selecting && !deleting && (
        <Checkbox
          isSelected={selected}
          onChange={onSelect}
          aria-labelledby={textId}
          className="group flex min-h-11 min-w-11 items-start justify-center pt-1"
        >
          <span className="flex size-5 items-center justify-center rounded border border-border-strong group-data-selected:bg-accent group-data-selected:text-accent-contrast group-data-focus-visible:outline-2 group-data-focus-visible:outline-focus-ring">
            {selected && <Check aria-hidden="true" size={14} />}
          </span>
        </Checkbox>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {editing ? (
          <TextField
            value={draft}
            onChange={setDraft}
            maxLength={2000}
            isInvalid={error !== null}
            className="flex flex-col gap-1"
            onKeyDown={(e) => e.key === "Escape" && stopEditing()}
          >
            <Label className="text-sm font-medium">Edit note</Label>
            <TextArea
              // Edit was just pressed and the field replaces the text, so focus goes into it.
              autoFocus
              rows={3}
              className="rounded-lg border border-border-strong bg-surface p-2"
            />
            {error && <p className="text-sm text-danger">{error}</p>}
          </TextField>
        ) : (
          <p id={textId} className="flex items-start gap-2 break-words">
            {instruction && <Lock aria-label="Standing instruction" size={16} className="mt-1" />}
            <span>{note.text}</span>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <TrustChip trust={note.trust} />
          {deleting ? (
            <span className="text-sm text-text-muted">Deleting…</span>
          ) : (
            <NoteMeta note={note} />
          )}
        </div>
        {editing ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onPress={save}
              isDisabled={saving || draft.trim() === "" || draft.trim() === note.text}
            >
              Save
            </Button>
            <Button onPress={stopEditing}>Cancel</Button>
          </div>
        ) : (
          !selecting &&
          !deleting && (
            <div ref={actions} className="-mb-2 -ml-3 flex flex-wrap gap-1">
              {note.trust !== "system" && (
                <Button
                  variant="quiet"
                  aria-label={`Edit: ${note.text}`}
                  onPress={() => {
                    setDraft(note.text);
                    setEditing(true);
                  }}
                >
                  Edit
                </Button>
              )}
              <Button variant="quiet" aria-label={`Delete: ${note.text}`} onPress={onDelete}>
                Delete
              </Button>
            </div>
          )
        )}
        {(note.op === "update" || note.op === "merge") && !editing && (
          <EarlierVersions id={note.id} />
        )}
      </div>
    </li>
  );
}
