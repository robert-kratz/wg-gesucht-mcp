import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type BrowserContext, chromium, type Page } from "playwright";
import lockfile from "proper-lockfile";
import type { Account, Config } from "./config.js";
import { getAccount } from "./config.js";
import { AppError } from "./errors.js";
import { LoginCoordinator } from "./login.js";
import { atomicJson, readJson, SerialQueue } from "./storage.js";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
interface Session {
  context: BrowserContext;
  page: Page;
  release: () => Promise<void>;
}
export class BrowserManager {
  private sessions = new Map<string, Session>();
  private queues = new Map<string, SerialQueue>();
  private closing = false;
  readonly logins: LoginCoordinator;
  constructor(
    readonly config: Config,
    private readonly launch = chromium.launchPersistentContext.bind(chromium),
  ) {
    this.logins = new LoginCoordinator((id, signal, progress) =>
      this.visibleLogin(id, signal, progress),
    );
  }
  private filterState(state: StorageState): StorageState {
    const host = new URL(this.config.baseUrl).hostname;
    const allowed = (domain: string) => {
      const normalized = domain.replace(/^\./, "");
      return (
        normalized === host ||
        (host.endsWith(`.${normalized}`) && normalized.endsWith("wg-gesucht.de"))
      );
    };
    return {
      cookies: state.cookies.filter((c) => allowed(c.domain)),
      origins: state.origins.filter((o) => {
        try {
          return allowed(new URL(o.origin).hostname);
        } catch {
          return false;
        }
      }),
    };
  }
  private directory(accountId: string) {
    getAccount(this.config, accountId);
    return join(this.config.dataDir, "accounts", accountId);
  }
  private queue(accountId: string) {
    let queue = this.queues.get(accountId);
    if (!queue) {
      queue = new SerialQueue();
      this.queues.set(accountId, queue);
    }
    return queue;
  }
  async run<T>(
    accountId: string,
    operation: (page: Page, context: BrowserContext) => Promise<T>,
    authenticate = true,
  ): Promise<T> {
    getAccount(this.config, accountId);
    if (this.logins.active(accountId))
      throw new AppError(
        "LOGIN_IN_PROGRESS",
        "Complete the browser login, then retry this operation.",
      );
    return this.queue(accountId).run(async () => {
      if (this.closing) throw new AppError("SHUTTING_DOWN", "The server is shutting down.");
      if (this.logins.active(accountId))
        throw new AppError(
          "LOGIN_IN_PROGRESS",
          "Complete the browser login, then retry this operation.",
        );
      const session = await this.session(accountId);
      try {
        if (authenticate)
          await this.ensureAuthenticated(session.page, getAccount(this.config, accountId));
        return await operation(session.page, session.context);
      } finally {
        await this.persist(accountId, session.context);
      }
    });
  }
  private async session(accountId: string, visible = false): Promise<Session> {
    const existing = this.sessions.get(accountId);
    if (existing) return existing;
    const directory = this.directory(accountId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    let release: () => Promise<void>;
    try {
      const unlock = await lockfile.lock(directory, { stale: 30_000, update: 10_000, retries: 0 });
      let released: Promise<void> | undefined;
      release = () => (released ??= unlock());
    } catch {
      throw new AppError(
        "ACCOUNT_BUSY",
        "Another local process owns this account profile. Disconnect that MCP client before using the same account here, or configure a separate account profile. A crashed process lock expires after 30 seconds.",
      );
    }
    let context: BrowserContext | undefined;
    try {
      context = await this.launch(join(directory, "browser"), {
        channel: this.config.browserChannel === "chromium" ? undefined : this.config.browserChannel,
        headless: visible ? false : this.config.headless,
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        acceptDownloads: true,
        chromiumSandbox: process.platform === "linux",
      });
      context.setDefaultTimeout(this.config.timeoutMs);
      context.setDefaultNavigationTimeout(this.config.timeoutMs);
      const state = await readJson<StorageState>(join(directory, "session.json"));
      if (state) await context.setStorageState(state);
      const page = context.pages()[0] ?? (await context.newPage());
      const session = { context, page, release };
      this.sessions.set(accountId, session);
      context.on("close", () => {
        if (this.sessions.get(accountId) === session) this.sessions.delete(accountId);
        void release().catch(() => undefined);
      });
      return session;
    } catch (error) {
      await context?.close().catch(() => undefined);
      await release();
      throw error;
    }
  }
  async persist(accountId: string, context: BrowserContext): Promise<void> {
    if (context.browser()?.isConnected() === false) return;
    await atomicJson(
      join(this.directory(accountId), "session.json"),
      this.filterState(await context.storageState({ indexedDB: true })),
    );
  }
  async isAuthenticated(page: Page): Promise<boolean> {
    return (
      new URL(page.url()).origin === new URL(this.config.baseUrl).origin &&
      (await page.locator('a[href="/my-profile.html"]').count()) > 0 &&
      (await page.locator("#pre_session_form:visible,#login_form:visible").count()) === 0
    );
  }
  private async ensureAuthenticated(page: Page, account: Account): Promise<void> {
    await page.goto(`${this.config.baseUrl}/meine-anzeigen.html`, {
      waitUntil: "domcontentloaded",
    });
    if (await this.isAuthenticated(page)) return;
    const email = account.emailEnv ? this.config.env[account.emailEnv] : undefined;
    const password = account.passwordEnv ? this.config.env[account.passwordEnv] : undefined;
    if (!email || !password) throw this.loginRequired(account.id);
    try {
      await dismissConsent(page);
      if (!(await page.locator("#pre_session_email").isVisible())) {
        await page.getByRole("link", { name: "Mein Konto", exact: true }).first().click();
      }
      await page.locator("#pre_session_email").fill(email);
      await page
        .locator("#pre_session_form")
        .getByRole("button", { name: "Weiter", exact: true })
        .click();
      await page.locator("#login_password").fill(password);
      await page
        .locator("#login_form")
        .getByRole("button", { name: "Einloggen", exact: true })
        .click();
      await page
        .locator('a[href="/my-profile.html"]')
        .first()
        .waitFor({ state: "attached", timeout: 15_000 });
      if (!(await this.isAuthenticated(page))) throw this.loginRequired(account.id);
    } catch {
      throw this.loginRequired(account.id);
    }
  }
  private loginRequired(accountId: string) {
    return new AppError(
      "LOGIN_REQUIRED",
      "Login expired, missing, or requires manual verification. Call login_account to open the interactive browser. CAPTCHA and 2FA remain manual.",
      { accountId, tool: "login_account", command: `wg-gesucht-mcp login --account ${accountId}` },
    );
  }
  beginLogin(accountId: string, timeoutMs = 300_000) {
    getAccount(this.config, accountId);
    if (this.closing) throw new AppError("SHUTTING_DOWN", "The server is shutting down.");
    return this.logins.start(accountId, timeoutMs);
  }
  async login(accountId: string, timeoutMs = 300_000): Promise<void> {
    this.beginLogin(accountId, timeoutMs);
    const result = await this.logins.wait(accountId);
    if (result.state !== "authenticated")
      throw new AppError(
        result.error?.code || (result.state === "timed_out" ? "LOGIN_TIMEOUT" : "LOGIN_CANCELLED"),
        result.error?.message || "The interactive login ended without authentication. Try again.",
      );
  }
  private async closeSession(accountId: string, session: Session): Promise<void> {
    try {
      await session.context.close();
    } finally {
      if (this.sessions.get(accountId) === session) this.sessions.delete(accountId);
      await session.release();
    }
  }
  private async visibleLogin(
    accountId: string,
    signal: AbortSignal,
    progress: (state: "waiting_for_login" | "saving_session") => void,
  ) {
    await this.queue(accountId).run(async () => {
      signal.throwIfAborted();
      // A previously opened headless context cannot be turned into a visible window.
      const previous = this.sessions.get(accountId);
      if (previous) {
        await this.persist(accountId, previous.context);
        await this.closeSession(accountId, previous);
      }
      signal.throwIfAborted();
      let session: Session;
      try {
        session = await this.session(accountId, true);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          "LOGIN_BROWSER_UNAVAILABLE",
          "A visible browser could not start. Run the MCP directly on your desktop and install the configured browser using pnpm browsers:install, or select an installed Chrome channel.",
        );
      }
      try {
        signal.throwIfAborted();
        await session.page.goto(`${this.config.baseUrl}/meine-anzeigen.html`, {
          waitUntil: "domcontentloaded",
        });
        await dismissConsent(session.page);
        if (!(await this.isAuthenticated(session.page))) {
          const link = session.page.getByRole("link", { name: "Mein Konto", exact: true }).first();
          if (
            !(await session.page.locator("#pre_session_email").isVisible()) &&
            (await link.isVisible())
          )
            await link.click();
        }
        progress("waiting_for_login");
        while (!signal.aborted) {
          if (session.page.isClosed())
            throw new AppError(
              "LOGIN_CANCELLED",
              "The login window was closed before authentication.",
            );
          if (await this.isAuthenticated(session.page)) {
            signal.throwIfAborted();
            progress("saving_session");
            await this.persist(accountId, session.context);
            return;
          }
          await delay(300, undefined, { signal });
        }
        signal.throwIfAborted();
      } catch (error) {
        if (session.page.isClosed())
          throw new AppError(
            "LOGIN_CANCELLED",
            "The login window was closed before authentication.",
          );
        throw error;
      } finally {
        await this.closeSession(accountId, session);
      }
    });
  }
  async status(accountId: string) {
    const account = getAccount(this.config, accountId);
    const info = await stat(join(this.directory(accountId), "session.json")).catch(() => undefined);
    return {
      accountId: account.id,
      label: account.label,
      savedSession: Boolean(info),
      sessionUpdatedAt: info?.mtime.toISOString(),
      browserOpen: this.sessions.has(accountId),
      readOnly: this.config.readOnly,
      login: this.logins.status(accountId),
    };
  }
  async exportSession(accountId: string, output: string): Promise<void> {
    await this.run(accountId, async (_page, context) => {
      await atomicJson(resolve(output), {
        version: 1,
        accountId,
        storageState: this.filterState(await context.storageState({ indexedDB: true })),
      });
    });
  }
  async importSession(accountId: string, input: string): Promise<void> {
    const raw = JSON.parse(await readFile(resolve(input), "utf8")) as {
      version?: number;
      storageState?: StorageState;
    };
    if (
      raw.version !== 1 ||
      !Array.isArray(raw.storageState?.cookies) ||
      !Array.isArray(raw.storageState?.origins)
    )
      throw new AppError("INVALID_SESSION", "Expected a session file produced by session export.");
    if (this.logins.active(accountId))
      throw new AppError("LOGIN_IN_PROGRESS", "Complete the interactive login before importing.");
    await this.installSession(accountId, raw.storageState);
  }
  private async installSession(accountId: string, raw: unknown): Promise<void> {
    getAccount(this.config, accountId);
    let state: StorageState;
    let filtered: StorageState;
    try {
      state = raw as StorageState;
      if (!Array.isArray(state?.cookies) || !Array.isArray(state?.origins)) throw Error();
      filtered = this.filterState(state);
    } catch {
      throw new AppError("INVALID_SESSION", "Expected a valid WG-Gesucht browser session.");
    }
    if (
      filtered.cookies.length !== state.cookies.length ||
      filtered.origins.length !== state.origins.length
    ) {
      throw new AppError(
        "INVALID_SESSION",
        "The session contains data outside WG-Gesucht. Export a WG-Gesucht-only session.",
      );
    }
    await this.queue(accountId).run(async () => {
      if (this.closing) throw new AppError("SHUTTING_DOWN", "The server is shutting down.");
      const { context, page } = await this.session(accountId);
      const previous = await context.storageState({ indexedDB: true });
      try {
        await context.setStorageState(state);
        await page.goto(`${this.config.baseUrl}/meine-anzeigen.html`, {
          waitUntil: "domcontentloaded",
        });
        if (!(await this.isAuthenticated(page))) throw this.loginRequired(accountId);
        await this.persist(accountId, context);
      } catch (error) {
        await context.setStorageState(previous);
        throw error;
      }
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.logins.close();
    await Promise.all(
      [...this.sessions.entries()].map(([id, session]) =>
        this.queue(id).run(async () => {
          try {
            await this.persist(id, session.context);
          } finally {
            await this.closeSession(id, session);
          }
        }),
      ),
    );
  }
}

export async function dismissConsent(page: Page): Promise<void> {
  const save = page.getByRole("button", { name: /^(Save|Auswahl speichern|Speichern)$/ }).first();
  if (
    (await page.getByRole("dialog", { name: /consent|Zustimmung|Einwilligung/i }).count()) &&
    (await save.isVisible())
  )
    await save.click();
}
