let sequence = 0;
// Correlation/object IDs only, never authentication or pairing tokens.
export function newId(prefix: string): string {
  return (
    prefix +
    '_' +
    Date.now().toString(36) +
    '_' +
    (++sequence).toString(36) +
    '_' +
    Math.random().toString(36).slice(2, 10)
  );
}
