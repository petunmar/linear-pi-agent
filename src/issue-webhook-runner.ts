import { isKnownAgentIssue } from "./agent-issues.js";
import { createIssueComment, getInstalledAppUserId, getIssueForWebhook } from "./linear.js";
import { runPi } from "./pi-runner.js";
import type { AgentSessionWebhook } from "./session-runner.js";

type LinearUserRef = {
  id?: string;
  name?: string;
};

type LinearIssueRef = {
  id?: string;
  identifier?: string;
  title?: string;
  url?: string;
  description?: string | null;
  assignee?: LinearUserRef | null;
};

type LinearCommentRef = {
  id?: string;
  body?: string;
  user?: LinearUserRef | null;
  issue?: LinearIssueRef | null;
};

export type AssignedIssueWebhook = {
  type?: string;
  action?: string;
  data?: unknown;
  updatedFrom?: Record<string, unknown>;
};

type IssueRunState = {
  running: boolean;
  pendingPayload?: AssignedIssueWebhook;
};

const issueRuns = new Map<string, IssueRunState>();
const AGENT_SESSION_COMMENT_DEBOUNCE_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asIssueRef(value: unknown): LinearIssueRef | undefined {
  if (!isObject(value)) return undefined;
  return value as LinearIssueRef;
}

function eventIssue(payload: AssignedIssueWebhook): LinearIssueRef | undefined {
  if (!isObject(payload.data)) return undefined;
  if (payload.type === "Comment") return asIssueRef((payload.data as LinearCommentRef).issue);
  return asIssueRef(payload.data);
}

function eventComment(payload: AssignedIssueWebhook): LinearCommentRef | undefined {
  if (payload.type !== "Comment" || !isObject(payload.data)) return undefined;
  return payload.data as LinearCommentRef;
}

function issueSessionId(issueId: string): string {
  return `issue-${issueId}`;
}

function formatUpdatedFrom(updatedFrom: Record<string, unknown> | undefined): string {
  if (!updatedFrom || Object.keys(updatedFrom).length === 0) return "";
  return `\nUpdated from:\n${JSON.stringify(updatedFrom, null, 2)}`;
}

function buildEventContext(payload: AssignedIssueWebhook, issue: LinearIssueRef): string {
  const comment = eventComment(payload);
  const parts = [
    `Linear webhook event: ${payload.type ?? "unknown"} ${payload.action ?? "unknown"}`,
    comment?.body ? `\nNew comment:\n${comment.body}` : undefined,
    formatUpdatedFrom(payload.updatedFrom),
    "\nThis issue is assigned to the Linear app user for Pi. React to the event and make any appropriate code or issue-related changes. If no code change is needed, explain that briefly.",
  ];

  return parts.filter(Boolean).join("\n");
}

async function resolveIssue(payload: AssignedIssueWebhook): Promise<LinearIssueRef | undefined> {
  const issue = eventIssue(payload);
  if (!issue?.id) return issue;

  if (issue.assignee?.id && issue.identifier && issue.title && issue.url) return issue;

  const fetched = await getIssueForWebhook(issue.id);
  return {
    ...fetched,
    ...issue,
    assignee: issue.assignee ?? fetched.assignee,
    description: issue.description ?? fetched.description,
    identifier: issue.identifier ?? fetched.identifier,
    title: issue.title ?? fetched.title,
    url: issue.url ?? fetched.url,
  };
}

async function shouldHandle(payload: AssignedIssueWebhook, issue: LinearIssueRef): Promise<boolean> {
  if (!issue.id) return false;

  const appUserId = await getInstalledAppUserId();
  const comment = eventComment(payload);
  if (comment?.user?.id === appUserId) {
    console.log("ignoring Linear comment created by app user", { issueId: issue.id, commentId: comment.id });
    return false;
  }

  if (isKnownAgentIssue(issue)) {
    console.log("ignoring Linear issue/comment event for known agent session issue; AgentSessionEvent handles it", {
      type: payload.type,
      action: payload.action,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      commentId: comment?.id,
    });
    return false;
  }

  if (issue.assignee?.id !== appUserId) {
    console.log("ignoring Linear event for issue not assigned to app user or known agent session", {
      type: payload.type,
      action: payload.action,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      assigneeId: issue.assignee?.id,
      appUserId,
    });
    return false;
  }

  return true;
}

export function isIssueRelatedWebhook(payload: { type?: string }): boolean {
  return payload.type === "Issue" || payload.type === "Comment";
}

export async function handleAssignedIssueWebhook(payload: AssignedIssueWebhook): Promise<void> {
  const issue = await resolveIssue(payload);
  if (!issue?.id) {
    console.warn("Linear issue/comment webhook missing issue.id", { type: payload.type, action: payload.action });
    return;
  }

  if (!isKnownAgentIssue(issue)) {
    // Linear agent sessions also emit ordinary Issue/Comment webhooks near the
    // AgentSessionEvent. Give the session webhook a short window to register
    // the issue, then let the AgentSessionEvent path be the single source of
    // truth. If no session registers, this remains the fallback path for issues
    // assigned directly to the app user.
    await sleep(AGENT_SESSION_COMMENT_DEBOUNCE_MS);
    if (isKnownAgentIssue(issue)) {
      console.log("ignoring debounced Linear issue/comment event for known agent session issue; AgentSessionEvent handles it", {
        type: payload.type,
        action: payload.action,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        commentId: eventComment(payload)?.id,
      });
      return;
    }
  }

  if (!(await shouldHandle(payload, issue))) return;

  const state = issueRuns.get(issue.id) ?? { running: false };
  issueRuns.set(issue.id, state);

  if (state.running) {
    state.pendingPayload = payload;
    await createIssueComment(issue.id, "Pi received this Linear event and will handle it after the current run finishes.");
    return;
  }

  startIssueRun(issue, payload, state);
}

function startIssueRun(issue: LinearIssueRef, payload: AssignedIssueWebhook, state: IssueRunState): void {
  if (!issue.id) return;
  state.running = true;

  void runIssue(issue, payload, state).catch(async (error: Error) => {
    state.running = false;
    console.error("pi issue event run crashed", { issueId: issue.id, message: error.message });
    if (issue.id) {
      await createIssueComment(issue.id, `Pi failed to handle this Linear event: ${error.message}`).catch(
        (commentError: Error) => console.error("failed to post pi issue crash comment", { message: commentError.message }),
      );
    }
  });
}

async function runIssue(issue: LinearIssueRef, payload: AssignedIssueWebhook, state: IssueRunState): Promise<void> {
  if (!issue.id) return;

  console.log("pi issue event run started", { issueId: issue.id, type: payload.type, action: payload.action });

  const piPayload: AgentSessionWebhook = {
    action: "created",
    promptContext: buildEventContext(payload, issue),
    agentSession: {
      id: issueSessionId(issue.id),
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        description: issue.description,
      },
    },
  };

  const result = await runPi(piPayload);
  console.log("pi issue event run finished", { issueId: issue.id, exitCode: result.exitCode, timedOut: result.timedOut });

  if (result.exitCode === 0 && !result.timedOut) {
    await createIssueComment(issue.id, result.summary);
  } else {
    const reason = result.timedOut
      ? "pi timed out"
      : `pi exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`;
    await createIssueComment(issue.id, `${reason}\n\n${result.summary}`);
  }

  state.running = false;

  const pendingPayload = state.pendingPayload;
  if (pendingPayload) {
    state.pendingPayload = undefined;
    const pendingIssue = await resolveIssue(pendingPayload);
    if (pendingIssue?.id) startIssueRun(pendingIssue, pendingPayload, state);
  }
}
