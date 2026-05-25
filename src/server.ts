import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { config, publicConfig } from "./config.js";
import { completeOAuthInstall, consumeOAuthState, createInstallUrl } from "./oauth.js";
import { handleAssignedIssueWebhook, isIssueRelatedWebhook } from "./issue-webhook-runner.js";
import { handleAgentSessionWebhook } from "./session-runner.js";
import { isFreshWebhookTimestamp, verifyLinearSignature } from "./signature.js";

type LinearWebhookPayload = {
  type?: string;
  action?: string;
  webhookTimestamp?: number;
  data?: unknown;
  updatedFrom?: Record<string, unknown>;
  agentSession?: {
    id?: string;
    issue?: {
      id?: string;
      identifier?: string;
      title?: string;
      url?: string;
    };
  };
};

function rawBody(req: Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

function logWebhook(payload: LinearWebhookPayload) {
  const agentActivity = (payload as { agentActivity?: { content?: { type?: string; body?: string } } }).agentActivity;
  console.log("linear webhook received", {
    type: payload.type,
    action: payload.action,
    agentSessionId: payload.agentSession?.id,
    issue: payload.agentSession?.issue?.identifier,
    activityType: agentActivity?.content?.type,
    activityBody: agentActivity?.content?.body?.slice(0, 120),
  });
}

function handleAgentSessionEvent(payload: LinearWebhookPayload) {
  void handleAgentSessionWebhook(payload).catch((error: Error) => {
    console.error("failed to handle agent session webhook", { message: error.message });
  });
}

function handleIssueRelatedEvent(payload: LinearWebhookPayload) {
  void handleAssignedIssueWebhook(payload).catch((error: Error) => {
    console.error("failed to handle assigned issue webhook", { message: error.message });
  });
}

function acceptsWebhook(payload: LinearWebhookPayload): boolean {
  return payload.type === "AgentSessionEvent" || isIssueRelatedWebhook(payload);
}

function installSecretFromRequest(req: Request): string | undefined {
  const header = req.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return typeof req.query.install_secret === "string" ? req.query.install_secret : undefined;
}

function isInstallAuthorized(req: Request): boolean {
  if (!config.INSTALL_SECRET) return true;
  const provided = installSecretFromRequest(req);
  if (!provided) return false;

  const expected = Buffer.from(config.INSTALL_SECRET);
  const actual = Buffer.from(provided);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "linear-pi-agent" });
  });

  app.get("/linear/install", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      if (!isInstallAuthorized(req)) {
        return res.status(401).type("text/plain").send("Missing or invalid install secret.\n");
      }

      const installUrl = await createInstallUrl();
      res.redirect(302, installUrl);
    } catch (error) {
      next(error);
    }
  });

  app.get("/linear/oauth/callback", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      if (typeof req.query.error === "string") {
        return res.status(400).send(`Linear OAuth error: ${req.query.error}\n`);
      }

      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const state = typeof req.query.state === "string" ? req.query.state : undefined;

      if (!code || !state) {
        return res.status(400).send("Missing OAuth code or state.\n");
      }

      if (!(await consumeOAuthState(state))) {
        return res.status(401).send("Invalid or expired OAuth state.\n");
      }

      const install = await completeOAuthInstall(code);
      console.log("linear app installed", {
        viewerAppUserId: install.viewerAppUserId,
        scope: install.scope,
      });

      return res.type("text/plain").send(
        [
          "Pi is installed in Linear.",
          `App user ID: ${install.viewerAppUserId}`,
          "You can close this tab.",
          "",
        ].join("\n"),
      );
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/linear/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    (req: Request, res: Response) => {
      const body = rawBody(req);

      if (!verifyLinearSignature(req.get("linear-signature"), body)) {
        return res.status(401).json({ ok: false, error: "invalid_signature" });
      }

      let payload: LinearWebhookPayload;
      try {
        payload = parseJsonBody(body) as LinearWebhookPayload;
      } catch {
        return res.status(400).json({ ok: false, error: "invalid_json" });
      }

      if (!isFreshWebhookTimestamp(payload.webhookTimestamp)) {
        return res.status(401).json({ ok: false, error: "stale_webhook" });
      }

      logWebhook(payload);
      const accepted = acceptsWebhook(payload);
      if (payload.type === "AgentSessionEvent") {
        handleAgentSessionEvent(payload);
      } else if (isIssueRelatedWebhook(payload)) {
        handleIssueRelatedEvent(payload);
      }

      return res.status(200).json({ ok: true, accepted });
    },
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: "not_found" });
  });

  app.use((error: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error("request failed", { name: error.name, message: error.message });
    res.status(500).json({ ok: false, error: "internal_error" });
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = createApp();
  app.listen(config.PORT, config.HOST, () => {
    console.log("linear pi agent listening", publicConfig());
  });
}
