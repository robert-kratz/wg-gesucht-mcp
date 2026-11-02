import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "dotenv";
import { z } from "zod";
import { AppError } from "./errors.js";

export const accountIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const accountSchema = z.strictObject({
  id: accountIdSchema,
  label: z.string().max(120).optional(),
  emailEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional(),
  passwordEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional(),
});
const accountsSchema = z.strictObject({ accounts: z.array(accountSchema).min(1).max(100) });
export type Account = z.infer<typeof accountSchema>;
export interface Config {
  accounts: Account[];
  dataDir: string;
  attachmentRoots: string[];
  readOnly: boolean;
  headless: boolean;
  browserChannel: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
  baseUrl: string;
}
export interface ConfigOptions {
  config?: string;
  envFile?: string;
  dataDir?: string;
}

export async function loadConfig(
  options: ConfigOptions = {},
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<Config> {
  const base = options.envFile ? dirname(resolve(options.envFile)) : process.cwd();
  const fileEnv = options.envFile ? parse(await readFile(resolve(options.envFile))) : {};
  const env = { ...fileEnv, ...inherited };
  const configPath = options.config
    ? resolve(options.config)
    : resolve(base, env.WG_MCP_CONFIG || "accounts.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new AppError(
      "CONFIG_REQUIRED",
      "Cannot read accounts configuration. Copy accounts.example.json to accounts.json, or supply --config /absolute/path/accounts.json.",
    );
  }
  const parsed = accountsSchema.safeParse(raw);
  if (
    !parsed.success ||
    new Set(parsed.data.accounts.map((a) => a.id)).size !== parsed.data.accounts.length
  ) {
    throw new AppError(
      "INVALID_CONFIG",
      "Accounts must have unique, filesystem-safe IDs and optional environment variable references. See accounts.example.json.",
    );
  }
  const boolean = (name: string, fallback: boolean) => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    if (value !== "true" && value !== "false")
      throw new AppError("INVALID_CONFIG", `${name} must be true or false.`);
    return value === "true";
  };
  const split = (value: string | undefined) =>
    value
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean) ?? [];
  const browserChannel = env.WG_MCP_BROWSER_CHANNEL || "chromium";
  if (!["chromium", "chrome", "msedge"].includes(browserChannel))
    throw new AppError(
      "INVALID_CONFIG",
      "WG_MCP_BROWSER_CHANNEL must be chromium, chrome, or msedge.",
    );
  return {
    accounts: parsed.data.accounts,
    dataDir: options.dataDir
      ? resolve(options.dataDir)
      : resolve(base, env.WG_MCP_DATA_DIR || ".data"),
    attachmentRoots: split(env.WG_MCP_ATTACHMENT_ROOTS).map((p) => resolve(base, p)),
    readOnly: boolean("WG_MCP_READ_ONLY", true),
    headless: boolean("WG_MCP_HEADLESS", true),
    browserChannel,
    timeoutMs: 20_000,
    env,
    baseUrl: "https://www.wg-gesucht.de",
  };
}

export function getAccount(config: Config, accountId: string): Account {
  const account = config.accounts.find((a) => a.id === accountId);
  if (!account) throw new AppError("UNKNOWN_ACCOUNT", "The requested accountId is not configured.");
  return account;
}
