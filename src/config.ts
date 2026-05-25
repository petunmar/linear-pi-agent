import { homedir } from "node:os";
import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  LINEAR_CLIENT_ID: z.string().min(1),
  LINEAR_CLIENT_SECRET: z.string().min(1),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),
  INSTALL_SECRET: z.preprocess((value) => value === "" ? undefined : value, z.string().min(16).optional()),
  LINEAR_REDIRECT_URI: z.string().url(),
  BASE_URL: z.string().url(),
  PI_WORKDIR: z.string().min(1),
  PI_COMMAND: z.string().min(1).default("pi"),
  PI_MODE: z.enum(["text", "json"]).default("json"),
  PI_RUNNER: z.enum(["sdk", "cli"]).default("sdk"),
  PI_AGENT_DIR: z.string().default(`${homedir()}/.pi/agent`),
  PI_SESSION_DIR: z.string().default("./data/pi-sessions"),
  PI_PROGRESS_DEBOUNCE_MS: z.coerce.number().int().positive().default(3_000),
  PI_STATUS_UPDATE_MS: z.coerce.number().int().positive().default(60_000),
  PI_RAPID_UPDATE_WINDOW_MS: z.coerce.number().int().positive().default(180_000),
  PI_SLOW_STATUS_UPDATE_MS: z.coerce.number().int().positive().default(300_000),
  PI_TIMEOUT_MS: z.coerce.number().int().positive().default(5_400_000),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),
  TOKEN_STORE_PATH: z.string().default("./data/linear-tokens.json"),
  STATE_STORE_PATH: z.string().default("./data/oauth-states.json"),
});

export const config = ConfigSchema.parse(process.env);

// The pi SDK runs tool commands inside this long-lived Node process. Avoid
// leaking service-only PORT into repository test/dev commands; Fenra's e2e
// backend defaults to 8080, but inherited PORT=8787 made it collide with this
// webhook service and tempted agents to kill the webhook listener.
delete process.env.PORT;

export function publicConfig() {
  return {
    baseUrl: config.BASE_URL,
    redirectUri: config.LINEAR_REDIRECT_URI,
    installSecretConfigured: Boolean(config.INSTALL_SECRET),
    piWorkdir: config.PI_WORKDIR,
    piCommand: config.PI_COMMAND,
    piMode: config.PI_MODE,
    piRunner: config.PI_RUNNER,
    piAgentDir: config.PI_AGENT_DIR,
    piSessionDir: config.PI_SESSION_DIR,
    piProgressDebounceMs: config.PI_PROGRESS_DEBOUNCE_MS,
    piStatusUpdateMs: config.PI_STATUS_UPDATE_MS,
    piRapidUpdateWindowMs: config.PI_RAPID_UPDATE_WINDOW_MS,
    piSlowStatusUpdateMs: config.PI_SLOW_STATUS_UPDATE_MS,
    piTimeoutMs: config.PI_TIMEOUT_MS,
    host: config.HOST,
    port: config.PORT,
    tokenStorePath: config.TOKEN_STORE_PATH,
    stateStorePath: config.STATE_STORE_PATH,
  };
}
