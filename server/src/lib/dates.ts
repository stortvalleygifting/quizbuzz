/**
 * SQLite's `datetime('now')` stores UTC, but the string it writes
 * ("2026-09-18 15:34:20") carries no timezone marker. A browser handed that
 * raw reads it as *local* time, which would shift every signup by the reader's
 * offset — enough to put a date on the wrong side of a cutoff. So the stored
 * value is stamped as UTC on its way out of the API rather than rewritten in
 * the database, which leaves existing rows untouched.
 */
export function isoFromSqliteUtc(stored: string): string {
  const withT = stored.trim().replace(' ', 'T');
  // Already carries a zone (a value written by something other than SQLite's
  // datetime()) — leave it be.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(withT)) return withT;
  return `${withT}Z`;
}
