/** What went wrong, in the words the service used where it gave any. */
export const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
