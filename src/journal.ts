import { createHash } from "node:crypto";
import { join } from "node:path";
import { AppError, publicError } from "./errors.js";
import { atomicJson, readJson } from "./storage.js";

interface Entry {
  fingerprint: string;
  state: "pending" | "confirmed" | "unknown";
  result?: unknown;
}
export class SendJournal {
  constructor(private readonly directory: string) {}
  // The caller holds the account's cross-process browser lock and serial operation queue.
  async send<T>(
    accountId: string,
    requestId: string,
    payload: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = createHash("sha256").update(requestId).digest("hex");
    const path = join(this.directory, "accounts", accountId, "sends", `${key}.json`);
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const previous = await readJson<Entry>(path);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError(
          "REQUEST_ID_CONFLICT",
          "This requestId was used for a different message.",
        );
      if (previous.state === "confirmed") return previous.result as T;
      throw new AppError(
        "SEND_OUTCOME_UNKNOWN",
        "This request may already have been sent. Inspect the conversation manually. Do not resubmit it using another requestId.",
      );
    }
    await atomicJson(path, { fingerprint, state: "pending" } satisfies Entry);
    try {
      const result = await operation();
      await atomicJson(path, { fingerprint, state: "confirmed", result } satisfies Entry);
      return result;
    } catch (error) {
      await atomicJson(path, { fingerprint, state: "unknown" } satisfies Entry);
      throw new AppError(
        "SEND_OUTCOME_UNKNOWN",
        "Sending could not be confirmed. Inspect the conversation before taking further action. Uploads may already exist. This requestId will not be sent again.",
        { cause: publicError(error) },
      );
    }
  }
}
