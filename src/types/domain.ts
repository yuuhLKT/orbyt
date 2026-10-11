export type Project = {
  id: string;
  name: string;
  description: string;
  directory: string;
  maxConcurrentSessions: number;
  approvalPolicy: 'manual';
  createdAt: string;
  updatedAt: string;
};

export type ExecutionScope = {
  id: string;
  projectId: string;
  name: string;
  relativeDirectory: string;
  readAccess: boolean;
  writeAccess: boolean;
  conflictPolicy: string;
};

export type TaskStatus =
  | 'pending'
  | 'triaging'
  | 'awaiting_context'
  | 'awaiting_approval'
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'needs_reconciliation'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'canceled';

export type Task = {
  id: string;
  projectId: string;
  scopeId: string | null;
  title: string;
  description: string;
  source: 'manual' | 'github' | 'glpi';
  externalReference: string | null;
  externalUrl: string | null;
  externalStatus: string | null;
  externalUpdatedAt: string | null;
  linkedGlpiTicketId: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

export type AgentSession = {
  id: string;
  taskId: string;
  openCodeSessionId: string | null;
  sessionType: 'triage' | 'implementation' | 'review_assistance';
  workingDirectory: string;
  status: 'starting' | 'running' | 'interrupted' | 'completed' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

export type TaskRunState =
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'needs_reconciliation';

/** OpenCode permission details are intentionally tolerant of protocol evolution. */
export type PendingRunPermission = {
  id: string;
  title?: string | null;
  kind?: string | null;
  details?: unknown;
  options?: unknown[];
  [key: string]: unknown;
};

export type TaskRun = {
  id: string;
  taskId: string;
  projectId: string;
  taskRevision: number;
  state: TaskRunState;
  scopeDirectory: string | null;
  broadScope: boolean;
  sessionId?: string | null;
  progress?: unknown;
  output?: unknown;
  pendingPermissions?: PendingRunPermission[] | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  [key: string]: unknown;
};

export type OpenCodeSession = {
  id: string;
  projectId: string;
  projectName: string;
  projectDirectory: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  parentId: string | null;
};

export type TriageResult = {
  contextSufficiency: 'sufficient' | 'partial' | 'insufficient';
  complexity: 'low' | 'medium' | 'high';
  requirements: string[];
  missingInformation: string[];
  relevantFiles: string[];
  proposedExecutionScope: string | null;
  implementationPlan: string[];
  risks: string[];
  dependencies: string[];
  recommendedAction: 'request_context' | 'await_approval' | 'do_not_proceed';
};

export type GlpiTicketContext = {
  ticket: {
    id: number;
    title: string;
    content: string;
    status: string | null;
    updatedAt: string | null;
  };
  publicFollowups: {
    id: number;
    date: string | null;
    authorUserId: number | null;
    content: string;
  }[];
  documents: {
    id: number;
    name: string;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
  }[];
  followupsTruncated: boolean;
  documentsTruncated: boolean;
};

export type LinkedGlpiTicketContext = {
  ticketUrl: string;
  context: GlpiTicketContext;
};

export type DownloadedGlpiDocument = {
  documentId: number;
  filename: string;
  mimeType: string;
  bytes: number[];
};

export type AppSettings = Record<string, string>;

export type SourceConnection = {
  id: string;
  provider: 'github' | 'glpi';
  projectId: string;
  sourceKey: string;
  displayName: string;
  apiEndpoint: string;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SourceSyncResult = {
  connectionId: string;
  provider: 'github' | 'glpi';
  seen: number;
  imported: number;
  refreshed: number;
  unchanged: number;
  truncated: boolean;
  limit: number;
  syncedAt: string;
};

export type GitHubAccount = { id: number; login: string };
export type DeviceFlowPrompt = {
  verificationUri: string;
  userCode: string;
  expiresIn: number;
  interval: number;
};
export type DeviceFlowPollResult =
  | { status: 'pending'; data: { interval: number } }
  | { status: 'authorized'; data: { account: GitHubAccount } }
  | { status: 'expired' }
  | { status: 'denied' };
export type GitHubProject = { id: string; number: number; title: string; url: string };
export type GitHubSingleSelectOption = { id: string; name: string };
export type GitHubProjectField = {
  id: string;
  name: string;
  fieldType: string;
  options: GitHubSingleSelectOption[];
};
export type GitHubProjectSource = {
  projectId: string;
  organization: string;
  projectNumber: number;
  projectNodeId: string;
  projectTitle: string;
  statusFieldId: string;
  statusFieldName: string;
  pendingOptionId: string;
  pendingOptionName: string;
  executionScopeId: string | null;
  lastSyncedAt: string | null;
};
export type GitHubProjectSyncResult = {
  projectId: string;
  seen: number;
  imported: number;
  refreshed: number;
  unchanged: number;
  triageTaskIds: string[];
  syncedAt: string;
};

export type OpenCodeStatus = {
  connected: boolean;
  version: string | null;
  message: string;
  endpoint: string | null;
};
