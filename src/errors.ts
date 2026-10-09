// Errors carried in the JSON envelope, with the exit codes shared by task, due and oj.

export const ExitError = 1;
export const ExitUsage = 2;
export const ExitNotFound = 3;
export const ExitConflict = 4;
export const ExitLocked = 5;

export class RoutineError extends Error {
  readonly code: number;
  readonly kind: string;
  constructor(code: number, kind: string, message: string) {
    super(message);
    this.code = code;
    this.kind = kind;
  }
  toJSON() {
    return { code: this.code, kind: this.kind, message: this.message };
  }
}

export const userError = (message: string) => new RoutineError(ExitUsage, "user_error", message);
export const notFound = (message: string) => new RoutineError(ExitNotFound, "not_found", message);
export const conflict = (message: string) => new RoutineError(ExitConflict, "conflict", message);
export const locked = (message: string) => new RoutineError(ExitLocked, "locked", message);

export function asRoutineError(error: unknown): RoutineError {
  if (error instanceof RoutineError) return error;
  return new RoutineError(ExitError, "error", error instanceof Error ? error.message : String(error));
}
