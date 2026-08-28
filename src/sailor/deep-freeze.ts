/**
 * Freezes a value and everything reachable from it.
 *
 * Used on what the sailor hands out rather than on what it keeps: a context
 * read back from disk, a task snapshot inside an invocation. A holder that
 * passed one along by mistake cannot turn it into the shared mutable state
 * the per-agent layout exists to prevent.
 */
export const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }

  return Object.freeze(value);
};
