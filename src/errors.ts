export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function publicError(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (error instanceof AppError)
    return { code: error.code, message: error.message, details: error.details };
  // Browser exception messages can contain page contents, input values, and authenticated URLs.
  return {
    code: "AUTOMATION_ERROR",
    message:
      "The operation failed. Check authentication and the current website layout. No automatic retry was performed.",
  };
}

export function assertWrites(readOnly: boolean): void {
  if (readOnly)
    throw new AppError(
      "READ_ONLY",
      "Writes are disabled. Set WG_MCP_READ_ONLY=false explicitly to enable saves, uploads, and sending.",
    );
}
