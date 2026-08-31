/**
 * Expected failures are data. Throws are for programmer errors and violated
 * invariants — never for an outcome a caller is meant to handle.
 */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * Every recoverable failure in the package. `code` is a stable identifier a
 * caller may branch on; each layer narrows it to its own closed union. Nobody
 * ever reads `message` to decide behaviour.
 */
export interface Failure {
  code: string;
  message: string;
  retryable: boolean;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
