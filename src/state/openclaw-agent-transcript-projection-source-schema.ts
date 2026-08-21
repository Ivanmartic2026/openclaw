import type { DatabaseSync } from "node:sqlite";
import { TRANSCRIPT_PROJECTION_SOURCE_COLUMN_DEFINITIONS } from "./openclaw-agent-db-additive-columns.js";
import { ensureColumn, tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

const ENSURED_DATABASES = new WeakSet<DatabaseSync>();

function projectionSourceColumnsPresent(db: DatabaseSync): boolean {
  return TRANSCRIPT_PROJECTION_SOURCE_COLUMN_DEFINITIONS.every(
    ({ columnName, tableName }) =>
      !tableExists(db, tableName) || tableHasColumn(db, tableName, columnName),
  );
}

export function hasRetiredTranscriptProjectionBindingSchema(db: DatabaseSync): boolean {
  return tableExists(db, "session_transcript_projection_bindings");
}

export function dropRetiredTranscriptProjectionBindingSchema(db: DatabaseSync): void {
  if (!hasRetiredTranscriptProjectionBindingSchema(db)) {
    return;
  }
  // Retired derived ownership rows can become stale across a downgrade.
  // Removing them makes any older reader rebuild instead of trusting them.
  db.exec("DROP TABLE session_transcript_projection_bindings;");
}

/** Adds the nullable generation owner to each present projection-state table once. */
export function ensureOpenClawAgentTranscriptProjectionSourceColumns(db: DatabaseSync): void {
  if (ENSURED_DATABASES.has(db)) {
    return;
  }
  let addedColumn = false;
  for (const {
    columnName,
    dataType,
    tableName,
  } of TRANSCRIPT_PROJECTION_SOURCE_COLUMN_DEFINITIONS) {
    addedColumn = ensureColumn(db, tableName, `${columnName} ${dataType}`) || addedColumn;
  }
  if (!addedColumn || !db.isTransaction) {
    ENSURED_DATABASES.add(db);
    return;
  }
  setImmediate(() => {
    if (db.isOpen && !db.isTransaction && projectionSourceColumnsPresent(db)) {
      ENSURED_DATABASES.add(db);
    }
  });
}
