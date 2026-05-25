import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { createAgentActivity } from "./linear.js";
import type { AgentSessionWebhook } from "./session-runner.js";

const MAX_LINEAR_BODY_CHARS = 8_000;
const MAX_PROGRESS_CHARS = 220;

const LINEAR_AGENT_WORKFLOW_PROMPT = [
  "Linear agent workflow requirements:",
  "- Always work in a separate git worktree for the task, not in the main checkout.",
  "- Always work on a feature branch, never directly on main/master.",
  "- If you are not already in a suitable worktree and branch, create them before editing files.",
  "- Commit your completed changes.",
  "- When the work is done, push the branch and create a GitHub pull request.",
  "- Prefer the GitHub extension commands/tools when available; otherwise use gh/git directly.",
  "- If a PR cannot be created, clearly report the exact blocker and leave the local branch and commit ready.",
  "- Do not stop, kill, restart, or modify the Linear pi agent service, Caddy, systemd user services, or any process listening for Linear webhooks.",
  "- Do not kill arbitrary processes by port (for example, never run kill $(lsof -ti :PORT), fuser -k, pkill by generic server names, or broad docker cleanup).",
  "- Local app/test ports are fixed for infrastructure reasons. If a fixed dev/test port is occupied, first identify the owner with ss/lsof/docker ps/ps before acting.",
  "- You may clean up stale resources only when they are clearly owned by the same repository/worktree test harness, such as fenra-e2e-* Docker containers, child process trees whose cwd is the current worktree, or PIDs recorded by the harness. Prefer graceful termination first, then verify the port is free.",
  "- If the port owner is the Linear pi agent, Caddy, a systemd user service, a webhook listener, an unrelated worktree, or cannot be confidently identified as stale test infrastructure from your current worktree/repo, do not kill it; report the exact blocker.",
  "- Before rerunning tests after a port conflict, either reuse/clean only your own stale test resources or report the blocker; do not switch ports unless the repository/test command explicitly supports it.", 
].join("\n");

export type PiRunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputText: string;
  summary: string;
};

type ManagedSession = {
  session: AgentSession;
  unsubscribe: () => void;
  reporterRef: { current: ProgressReporter };
};

const sdkSessions = new Map<string, ManagedSession>();
let loggedExtensionDiscovery = false;

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const maybeText = (part as { text?: unknown }).text;
      return typeof maybeText === "string" ? [maybeText] : [];
    })
    .join("\n");
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  return textFromContent((message as { content?: unknown }).content);
}

function finalAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown } | undefined;
    if (message?.role !== "assistant") continue;
    const text = messageText(message).trim();
    if (text) return text;
  }
  return undefined;
}

function redact(text: string): string {
  return text
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH)[A-Z0-9_]*\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]");
}

function truncate(text: string, maxChars = MAX_PROGRESS_CHARS): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return toolName;
  const record = args as Record<string, unknown>;
  const pathValue = record.path ?? record.file_path ?? record.filePath;
  if (typeof pathValue === "string") return `${toolName} ${pathValue}`;
  const command = record.command;
  if (typeof command === "string") return `${toolName} ${command}`;
  const query = record.query;
  if (typeof query === "string") return `${toolName} ${query}`;
  return toolName;
}

function commandText(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command.toLowerCase() : "";
}

type StatusCategory = "reading" | "editing" | "testing" | "git" | "research" | "installing" | "shell";

function statusCategory(toolName: string, args: unknown): StatusCategory {
  const lowerTool = toolName.toLowerCase();
  const command = commandText(args);

  if (["read", "grep", "find", "ls"].includes(lowerTool)) return "reading";
  if (["edit", "write"].includes(lowerTool)) return "editing";
  if (["search", "web_fetch", "youtube_search", "video_extract"].includes(lowerTool)) return "research";
  if (command.match(/\b(npm|pnpm|yarn|bun)\s+(install|i|ci)\b/) || command.includes("apt ") || command.includes("brew ")) {
    return "installing";
  }
  if (command.match(/\b(test|eslint|tsc|vue-tsc|playwright|stagehand|cypress|vitest|jest|mocha|pytest)\b/)) {
    return "testing";
  }
  if (command.match(/\b(git|gh)\b/) || command.includes("pull request") || command.includes(" pr ")) return "git";
  if (lowerTool === "bash") return "shell";
  return "reading";
}

const STATUS_PHRASES: Record<StatusCategory, string> = {
  reading: "inspecting the codebase",
  editing: "making code changes",
  testing: "running checks or tests",
  git: "preparing branch or PR work",
  research: "looking up supporting context",
  installing: "preparing dependencies",
  shell: "checking the local environment",
};

function summarizeStatus(categories: Map<StatusCategory, number>): string | undefined {
  const ranked = [...categories.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, 2)
    .map(([category]) => STATUS_PHRASES[category]);

  if (!ranked.length) return undefined;
  if (ranked.length === 1) return `Still working — Pi is ${ranked[0]}.`;
  return `Still working — Pi is ${ranked[0]} and ${ranked[1]}.`;
}

function guidanceText(payload: AgentSessionWebhook): string {
  const rules = payload.guidance?.flatMap((rule) => rule.body ? [rule.body] : []) ?? [];
  if (!rules.length) return "";
  return `\n\nLinear guidance:\n${rules.map((rule) => `- ${rule}`).join("\n")}`;
}

export function buildPiPrompt(payload: AgentSessionWebhook): string {
  const issue = payload.agentSession?.issue;
  const promptContext = payload.promptContext ?? payload.agentSession?.promptContext;

  return [
    "You are running as Pi, a Linear custom agent powered by pi.",
    "Work directly in this repository with full control. Make code changes when appropriate.",
    "Do not expose secrets. Be concise in your final summary for Linear.",
    LINEAR_AGENT_WORKFLOW_PROMPT,
    "",
    issue ? "Linear issue:" : "Linear session:",
    issue?.id ? `- Linear issue ID: ${issue.id}` : undefined,
    issue?.identifier ? `- Identifier: ${issue.identifier}` : undefined,
    issue?.title ? `- Title: ${issue.title}` : undefined,
    issue?.url ? `- URL: ${issue.url}` : undefined,
    issue?.description ? `- Description:\n${issue.description}` : undefined,
    promptContext ? `\nLinear prompt context:\n${promptContext}` : undefined,
    guidanceText(payload),
    "",
    "When finished, summarize what changed, tests/checks run, and any remaining follow-up.",
  ].filter(Boolean).join("\n");
}

export function buildPiFollowUpPrompt(payload: AgentSessionWebhook): string {
  const followUp = payload.agentActivity?.content?.body?.trim();
  if (followUp) {
    return [
      "Linear user follow-up:",
      followUp,
      "",
      LINEAR_AGENT_WORKFLOW_PROMPT,
      "Continue from the existing session context. Be concise in your final summary for Linear.",
    ].join("\n");
  }

  const promptContext = payload.promptContext ?? payload.agentSession?.promptContext;
  if (promptContext) {
    return [
      "Linear follow-up context:",
      promptContext,
      "",
      LINEAR_AGENT_WORKFLOW_PROMPT,
      "Continue from the existing session context. Be concise in your final summary for Linear.",
    ].join("\n");
  }

  return [
    "Linear sent a follow-up event without message text.",
    LINEAR_AGENT_WORKFLOW_PROMPT,
    "Continue from the existing session context and summarize any useful status.",
  ].join("\n\n");
}

export function summarizePiResult(result: PiRunResult): string {
  const combined = [result.outputText.trim(), result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""]
    .filter(Boolean)
    .join("\n\n");

  if (!combined) {
    return result.exitCode === 0 ? "pi finished successfully without output." : "pi failed without output.";
  }

  const safe = redact(combined);
  if (safe.length <= MAX_LINEAR_BODY_CHARS) return safe;
  return `${safe.slice(0, MAX_LINEAR_BODY_CHARS)}\n\n…output truncated…`;
}

class ProgressReporter {
  private pending?: { type: "thought" | "action"; body: string; action?: string; parameter?: string };
  private timer?: NodeJS.Timeout;
  private statusTimer?: NodeJS.Timeout;
  private statusCategories = new Map<StatusCategory, number>();
  private lastSentAt = 0;
  private readonly startedAt = Date.now();

  constructor(private readonly agentSessionId: string) {}

  thought(body: string): void {
    this.queue({ type: "thought", body: truncate(body) });
  }

  status(toolName: string, args: unknown): void {
    const category = statusCategory(toolName, args);
    this.statusCategories.set(category, (this.statusCategories.get(category) ?? 0) + 1);
    this.ensureStatusTimer();
  }

  action(action: string, parameter: string): void {
    // Keep tool/progress updates visible without leaving action-type entries
    // that may be interpreted by Linear as still-active work state.
    this.queue({
      type: "thought",
      body: `${action}: ${parameter}`.trim(),
    });
  }

  private queue(update: { type: "thought" | "action"; body: string; action?: string; parameter?: string }): void {
    this.pending = update;
    const wait = Math.max(0, config.PI_PROGRESS_DEBOUNCE_MS - (Date.now() - this.lastSentAt));
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), wait);
    this.timer.unref();
  }

  private ensureStatusTimer(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      const summary = summarizeStatus(this.statusCategories);
      this.statusCategories.clear();
      if (summary) this.thought(summary);
      this.ensureStatusTimer();
    }, this.nextStatusDelayMs());
    this.statusTimer.unref();
  }

  private nextStatusDelayMs(): number {
    const elapsed = Date.now() - this.startedAt;
    if (elapsed < config.PI_RAPID_UPDATE_WINDOW_MS) {
      return Math.min(config.PI_STATUS_UPDATE_MS, config.PI_RAPID_UPDATE_WINDOW_MS - elapsed);
    }
    return config.PI_SLOW_STATUS_UPDATE_MS;
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const update = this.pending;
    this.pending = undefined;
    if (!update) return;
    this.lastSentAt = Date.now();
    try {
      if (update.type === "action") {
        await createAgentActivity(this.agentSessionId, {
          type: "action",
          action: update.action ?? "Processing",
          parameter: update.parameter ?? update.body,
        });
      } else {
        await createAgentActivity(this.agentSessionId, { type: "thought", body: update.body });
      }
    } catch (error) {
      console.error("failed to post pi progress", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.timer = undefined;
    this.statusTimer = undefined;
    this.pending = undefined;
    this.statusCategories.clear();
  }
}

async function getSdkSession(agentSessionId: string, reporter: ProgressReporter): Promise<ManagedSession> {
  const existing = sdkSessions.get(agentSessionId);
  if (existing) {
    existing.reporterRef.current = reporter;
    return existing;
  }

  const sessionDir = path.resolve(config.PI_SESSION_DIR);
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${agentSessionId}.jsonl`);
  const sessionManager = SessionManager.open(sessionFile, sessionDir, config.PI_WORKDIR);
  const { session, extensionsResult } = await createAgentSession({
    cwd: config.PI_WORKDIR,
    agentDir: config.PI_AGENT_DIR,
    sessionManager,
  });

  if (!loggedExtensionDiscovery) {
    loggedExtensionDiscovery = true;
    console.log("pi extensions loaded for Linear agent", {
      agentDir: config.PI_AGENT_DIR,
      cwd: config.PI_WORKDIR,
      extensions: extensionsResult.extensions.map((extension) => extension.path),
      errors: extensionsResult.errors,
    });
  }

  const reporterRef = { current: reporter };
  const unsubscribe = session.subscribe((event) => handleSdkEvent(event, reporterRef.current));
  await session.bindExtensions({});

  const managed = { session, unsubscribe, reporterRef };
  sdkSessions.set(agentSessionId, managed);
  return managed;
}

function disposeSdkSession(agentSessionId: string): void {
  const managed = sdkSessions.get(agentSessionId);
  if (!managed) return;
  managed.unsubscribe();
  managed.session.dispose();
  sdkSessions.delete(agentSessionId);
}

function handleSdkEvent(event: AgentSessionEvent, reporter: ProgressReporter): void {
  switch (event.type) {
    case "agent_start":
      break;
    case "tool_execution_start":
      reporter.status(event.toolName, event.args);
      break;
    case "message_end":
      // Do not mirror assistant messages as progress thoughts. Linear uses the
      // latest activity to infer session state; duplicating the final answer as
      // a thought after the response can move a completed session back to active.
      break;
    case "compaction_start":
      break;
    case "auto_retry_start":
      break;
    case "queue_update":
      break;
  }
}

export async function runPi(payload: AgentSessionWebhook): Promise<PiRunResult> {
  if (config.PI_RUNNER === "cli") {
    throw new Error("CLI pi runner fallback was removed from this build path; set PI_RUNNER=sdk or restore the legacy runner.");
  }

  const agentSessionId = payload.agentSession?.id;
  if (!agentSessionId) throw new Error("agentSession.id is required to run pi");

  const prompt = payload.action === "prompted" ? buildPiFollowUpPrompt(payload) : buildPiPrompt(payload);
  const reporter = new ProgressReporter(agentSessionId);
  const managed = await getSdkSession(agentSessionId, reporter);
  let finalText = "";
  const captureFinal = managed.session.subscribe((event) => {
    if (event.type === "agent_end") finalText = finalAssistantText(event.messages) ?? finalText;
    if (event.type === "turn_end") finalText = messageText(event.message).trim() || finalText;
  });

  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      managed.session.prompt(prompt),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error("pi timed out"));
        }, config.PI_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);

    await reporter.flush();
    const result: PiRunResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      outputText: finalText,
      summary: "",
    };
    result.summary = summarizePiResult(result);
    return result;
  } catch (error) {
    if (timedOut) {
      try {
        await managed.session.abort();
      } catch (abortError) {
        console.error("pi abort failed; disposing SDK session", {
          message: abortError instanceof Error ? abortError.message : String(abortError),
        });
        disposeSdkSession(agentSessionId);
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    const result: PiRunResult = {
      exitCode: timedOut ? null : 1,
      signal: null,
      timedOut,
      stdout: "",
      stderr: timedOut ? "" : message,
      outputText: finalText,
      summary: "",
    };
    result.summary = summarizePiResult(result);
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    reporter.dispose();
    captureFinal();
  }
}

export async function queuePiFollowUp(agentSessionId: string, prompt: string): Promise<boolean> {
  const managed = sdkSessions.get(agentSessionId);
  if (!managed?.session.isStreaming) return false;
  await managed.session.followUp(prompt);
  return true;
}

export async function abortPiSession(agentSessionId: string): Promise<boolean> {
  const managed = sdkSessions.get(agentSessionId);
  if (!managed?.session.isStreaming) return false;
  await managed.session.abort();
  return true;
}
