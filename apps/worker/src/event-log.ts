// SPDX-License-Identifier: Apache-2.0
// The per-conversation event log (M3-03 AC10), in the assistant's SQLite storage. Every event the
// DO broadcasts is stored first under a `seq` that never restarts per turn, so a tab that drops
// its socket can replay what it missed (AC11). It is runtime state, rebuildable by starting
// empty: D1 holds the messages, and a turn's rows are trimmed once it settles there. The counter
// outlives the trim, so a later turn's `seq` never reuses an earlier one's.

/** The synchronous SQL storage of a SQLite-backed Durable Object. */
export type Sql = Pick<SqlStorage, "exec">;

/** Far beyond any turn the limits allow (≤8 model calls of ≤4096 output tokens, soon M3-03c ④). */
const REPLAY_LIMIT = 100_000;
/** How long an ended task's progress counter is kept, to refuse what a late replay sends. */
const ENDED_KEEP_MS = 7 * 86_400_000;

export class EventLog {
  constructor(private readonly sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS event_log (
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      frame TEXT NOT NULL,
      PRIMARY KEY (conversation_id, seq)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS event_seq (
      conversation_id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS task_progress (
      task_id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL,
      ended_at INTEGER
    )`);
  }

  /**
   * Whether a promoted turn's task event is new, recording it if so (M3-12 AC8). A Workflow
   * replay sends its events again under the same per-task counter; a task whose turn has ended
   * gets nothing more into the log.
   */
  admit(taskId: string, seq: number): boolean {
    const [row] = this.sql
      .exec<{ last_seq: number; ended_at: number | null }>(
        "SELECT last_seq, ended_at FROM task_progress WHERE task_id = ?1",
        taskId,
      )
      .toArray();
    if (row && (row.ended_at !== null || seq <= row.last_seq)) return false;
    this.sql.exec(
      `INSERT INTO task_progress (task_id, last_seq) VALUES (?1, ?2)
       ON CONFLICT(task_id) DO UPDATE SET last_seq = ?2`,
      taskId,
      seq,
    );
    return true;
  }

  /** Closes a task's events at its turn's end; ended tasks' counters go after a week. */
  endTask(taskId: string, now: number): void {
    this.sql.exec("UPDATE task_progress SET ended_at = ?2 WHERE task_id = ?1", taskId, now);
    this.sql.exec("DELETE FROM task_progress WHERE ended_at < ?1", now - ENDED_KEEP_MS);
  }

  /**
   * Allocates the conversation's next `seq`, stores the frame `build` makes from it and returns
   * that frame for broadcast, so what a tab can replay is exactly what was sent. Storage is
   * synchronous and the DO single-threaded: nothing can slip between the two writes.
   */
  append(conversationId: string, turnId: string, build: (seq: number) => string): string {
    const { last_seq: seq } = this.sql
      .exec<{ last_seq: number }>(
        `INSERT INTO event_seq (conversation_id, last_seq) VALUES (?1, 1)
         ON CONFLICT(conversation_id) DO UPDATE SET last_seq = last_seq + 1
         RETURNING last_seq`,
        conversationId,
      )
      .one();
    const frame = build(seq);
    this.sql.exec(
      `INSERT INTO event_log (conversation_id, seq, turn_id, frame) VALUES (?1, ?2, ?3, ?4)`,
      conversationId,
      seq,
      turnId,
      frame,
    );
    return frame;
  }

  /** A turn's stored frames after `afterSeq`, in order. Empty once the turn has settled. */
  replay(conversationId: string, turnId: string, afterSeq: number): string[] {
    return this.sql
      .exec<{ frame: string }>(
        `SELECT frame FROM event_log
         WHERE conversation_id = ?1 AND turn_id = ?2 AND seq > ?3
         ORDER BY seq LIMIT ?4`,
        conversationId,
        turnId,
        afterSeq,
        REPLAY_LIMIT,
      )
      .toArray()
      .map(({ frame }) => frame);
  }

  /** Drops a settled turn's rows. The conversation's counter stays, so `seq` never restarts. */
  trim(conversationId: string, turnId: string): void {
    this.sql.exec(
      `DELETE FROM event_log WHERE conversation_id = ?1 AND turn_id = ?2`,
      conversationId,
      turnId,
    );
  }
}
