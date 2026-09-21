/** The part of the database client this module needs. */
export interface InsertClient {
  from(table: string): { insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }> };
}

export interface AuditEntry {
  actorId: string | null;
  action: string;        // e.g. "question.update", "grade.essay", "exam.open"
  entityType: string;    // e.g. "question", "exam", "session"
  entityId?: string | null;
  changes?: Record<string, unknown>;
}

/**
 * Records who did what. A failure is logged but does not undo the action the teacher just took.
 * Never put passwords, tokens, or answer keys in `changes`.
 */
export async function writeAudit(db: InsertClient, entry: AuditEntry): Promise<void> {
  const { error } = await db.from("audit_logs").insert({
    actor_id: entry.actorId,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    changes: entry.changes ?? {},
  });
  if (error) console.error(JSON.stringify({ message: "audit log write failed", action: entry.action, error: error.message }));
}
