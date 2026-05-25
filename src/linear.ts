import { config } from "./config.js";
import { readJsonFile, writePrivateJsonFile, type TokenRecord } from "./storage.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

type StoredInstallation = TokenRecord & {
  installed_at: number;
  updated_at: number;
};

type TokenStore = {
  default_app_user_id?: string;
  installations: Record<string, StoredInstallation>;
};

type LinearTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in: number;
  scope?: string | string[];
};

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string; path?: Array<string | number> }>;
};

export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

function now() {
  return Date.now();
}

function tokenStoreFallback(): TokenStore {
  return { installations: {} };
}

async function readTokenStore(): Promise<TokenStore> {
  return readJsonFile<TokenStore>(config.TOKEN_STORE_PATH, tokenStoreFallback());
}

async function writeTokenStore(store: TokenStore): Promise<void> {
  await writePrivateJsonFile(config.TOKEN_STORE_PATH, store);
}

async function selectInstallation(): Promise<{ store: TokenStore; appUserId: string; installation: StoredInstallation }> {
  const store = await readTokenStore();
  const appUserId = store.default_app_user_id ?? Object.keys(store.installations)[0];

  if (!appUserId) {
    throw new Error("Linear is not installed yet. Visit /linear/install first.");
  }

  const installation = store.installations[appUserId];
  if (!installation) {
    throw new Error("Linear token store is missing the default installation.");
  }

  return { store, appUserId, installation };
}

async function refreshInstallation(
  store: TokenStore,
  appUserId: string,
  installation: StoredInstallation,
): Promise<StoredInstallation> {
  if (!installation.refresh_token) {
    throw new Error("Linear access token expired and no refresh token is stored.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: installation.refresh_token,
    client_id: config.LINEAR_CLIENT_ID,
    client_secret: config.LINEAR_CLIENT_SECRET,
  });

  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = (await response.json()) as Partial<LinearTokenResponse> & { error_description?: string };

  if (!response.ok || !json.access_token || !json.expires_in) {
    throw new Error(`Linear token refresh failed: ${json.error_description ?? `HTTP ${response.status}`}`);
  }

  const refreshed: StoredInstallation = {
    ...installation,
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? installation.refresh_token,
    token_type: json.token_type,
    expires_at: now() + json.expires_in * 1000,
    scope: json.scope,
    updated_at: now(),
  };

  store.installations[appUserId] = refreshed;
  store.default_app_user_id = appUserId;
  await writeTokenStore(store);
  return refreshed;
}

async function getAccessToken(): Promise<string> {
  const { store, appUserId, installation } = await selectInstallation();

  if (installation.expires_at - REFRESH_SKEW_MS > now()) {
    return installation.access_token;
  }

  const refreshed = await refreshInstallation(store, appUserId, installation);
  return refreshed.access_token;
}

export async function linearGraphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const accessToken = await getAccessToken();

  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await response.json()) as GraphqlResponse<T>;

  if (!response.ok || json.errors?.length) {
    throw new Error(`Linear GraphQL failed: ${json.errors?.[0]?.message ?? `HTTP ${response.status}`}`);
  }

  if (!json.data) {
    throw new Error("Linear GraphQL response did not include data.");
  }

  return json.data;
}

export async function getLinearViewer(): Promise<{ id: string; name?: string }> {
  const data = await linearGraphql<{ viewer: { id: string; name?: string } }>(
    "query Viewer { viewer { id name } }",
  );
  return data.viewer;
}

export async function getInstalledAppUserId(): Promise<string> {
  const { appUserId } = await selectInstallation();
  return appUserId;
}

export async function getIssueForWebhook(issueId: string): Promise<{
  id: string;
  identifier?: string;
  title?: string;
  url?: string;
  description?: string | null;
  assignee?: { id?: string; name?: string } | null;
}> {
  const data = await linearGraphql<{
    issue: {
      id: string;
      identifier?: string;
      title?: string;
      url?: string;
      description?: string | null;
      assignee?: { id?: string; name?: string } | null;
    };
  }>(
    `query IssueForWebhook($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        url
        description
        assignee { id name }
      }
    }`,
    { id: issueId },
  );
  return data.issue;
}

export async function createIssueComment(issueId: string, body: string): Promise<{ id: string }> {
  const data = await linearGraphql<{ commentCreate: { success: boolean; comment: { id: string } } }>(
    `mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment { id }
      }
    }`,
    {
      input: {
        issueId,
        body,
      },
    },
  );

  if (!data.commentCreate.success) {
    throw new Error("Linear commentCreate returned success=false");
  }

  return { id: data.commentCreate.comment.id };
}

export async function createAgentActivity(
  agentSessionId: string,
  content: AgentActivityContent,
  options?: { ephemeral?: boolean },
): Promise<{ id: string }> {
  const data = await linearGraphql<{ agentActivityCreate: { success: boolean; agentActivity: { id: string } } }>(
    `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
        agentActivity { id }
      }
    }`,
    {
      input: {
        agentSessionId,
        content,
        ephemeral: options?.ephemeral,
      },
    },
  );

  if (!data.agentActivityCreate.success) {
    throw new Error("Linear agentActivityCreate returned success=false");
  }

  return { id: data.agentActivityCreate.agentActivity.id };
}
