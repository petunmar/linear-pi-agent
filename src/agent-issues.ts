type LinearIssueRef = {
  id?: string;
  identifier?: string;
};

const knownAgentIssueIds = new Set<string>();
const knownAgentIssueIdentifiers = new Set<string>();

export function registerAgentIssue(issue: LinearIssueRef | null | undefined): void {
  if (issue?.id) knownAgentIssueIds.add(issue.id);
  if (issue?.identifier) knownAgentIssueIdentifiers.add(issue.identifier);
}

export function isKnownAgentIssue(issue: LinearIssueRef | null | undefined): boolean {
  return Boolean(
    (issue?.id && knownAgentIssueIds.has(issue.id)) ||
    (issue?.identifier && knownAgentIssueIdentifiers.has(issue.identifier)),
  );
}
