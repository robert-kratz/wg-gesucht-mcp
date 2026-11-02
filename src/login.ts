import { randomUUID } from "node:crypto";
import { AppError, publicError } from "./errors.js";

export type LoginState =
  | "opening_browser"
  | "waiting_for_login"
  | "saving_session"
  | "authenticated"
  | "cancelled"
  | "timed_out"
  | "failed";

export interface LoginStatus {
  accountId: string;
  loginId: string;
  state: LoginState;
  startedAt: string;
  expiresAt: string;
  completedAt?: string;
  error?: ReturnType<typeof publicError>;
}

interface Job {
  status: LoginStatus;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  resolve: () => void;
}

/** Tracks interactive logins without holding an MCP request open for minutes. */
export class LoginCoordinator {
  private jobs = new Map<string, Job>();
  private tasks = new Set<Promise<void>>();
  private closing = false;

  constructor(
    private readonly localLogin: (
      accountId: string,
      signal: AbortSignal,
      progress: (state: "waiting_for_login" | "saving_session") => void,
    ) => Promise<void>,
  ) {}

  active(accountId: string): boolean {
    const job = this.jobs.get(accountId);
    return Boolean(job && !job.status.completedAt);
  }

  status(accountId: string): LoginStatus | undefined {
    const status = this.jobs.get(accountId)?.status;
    return status ? structuredClone(status) : undefined;
  }

  start(accountId: string, timeoutMs: number): LoginStatus {
    if (this.closing) throw new AppError("SHUTTING_DOWN", "The server is shutting down.");
    if (this.active(accountId)) return this.status(accountId) as LoginStatus;
    const controller = new AbortController();
    let resolve = () => {};
    const done = new Promise<void>((finished) => {
      resolve = finished;
    });
    const job: Job = {
      status: {
        accountId,
        loginId: randomUUID(),
        state: "opening_browser",
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      },
      controller,
      done,
      resolve,
      timer: setTimeout(() => {
        controller.abort();
        this.finish(job, "timed_out");
      }, timeoutMs),
    };
    job.timer.unref();
    this.jobs.set(accountId, job);
    const task = Promise.resolve()
      .then(() =>
        this.localLogin(accountId, controller.signal, (state) => {
          if (!job.status.completedAt) job.status.state = state;
        }),
      )
      .then(() => this.finish(job, "authenticated"))
      .catch((error: unknown) => {
        this.finish(
          job,
          error instanceof AppError && error.code === "LOGIN_CANCELLED" ? "cancelled" : "failed",
          error,
        );
      });
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    return this.status(accountId) as LoginStatus;
  }

  private finish(job: Job, state: LoginState, error?: unknown): void {
    if (job.status.completedAt) return;
    clearTimeout(job.timer);
    job.status.state = state;
    job.status.completedAt = new Date().toISOString();
    if (error) job.status.error = publicError(error);
    job.resolve();
  }

  async wait(accountId: string): Promise<LoginStatus> {
    const job = this.jobs.get(accountId);
    if (!job) throw new AppError("LOGIN_NOT_FOUND", "No login is in progress for this account.");
    await job.done;
    return structuredClone(job.status);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const job of this.jobs.values()) {
      job.controller.abort();
      this.finish(job, "cancelled");
    }
    await Promise.all(this.tasks);
  }
}
