import { invoke } from '@tauri-apps/api/core';
import type {
  AppSettings,
  DownloadedGlpiDocument,
  DeviceFlowPollResult,
  DeviceFlowPrompt,
  ExecutionScope,
  GitHubAccount,
  GitHubProject,
  GitHubProjectField,
  GitHubProjectSource,
  GitHubProjectSyncResult,
  LinkedGlpiTicketContext,
  OpenCodeSession,
  OpenCodeStatus,
  Project,
  SourceConnection,
  SourceSyncResult,
  Task,
  TaskRun,
  TriageResult,
} from '../types/domain';

export const api = {
  projects: () => invoke<Project[]>('list_projects'),
  createProject: (input: {
    name: string;
    description: string;
    directory: string;
    maxConcurrentSessions: number;
  }) => invoke<Project>('create_project', { input }),
  updateProject: (
    projectId: string,
    input: { name: string; description: string; directory: string; maxConcurrentSessions: number },
  ) => invoke<Project>('update_project', { projectId, input }),
  deleteProject: (projectId: string) => invoke<void>('delete_project', { projectId }),
  scopes: (projectId: string) => invoke<ExecutionScope[]>('list_scopes', { projectId }),
  createScope: (input: {
    projectId: string;
    name: string;
    relativeDirectory: string;
    readAccess: boolean;
    writeAccess: boolean;
  }) => invoke<ExecutionScope>('create_scope', { input }),
  deleteScope: (scopeId: string) => invoke<void>('delete_scope', { scopeId }),
  tasks: (projectId?: string) => invoke<Task[]>('list_tasks', { projectId: projectId ?? null }),
  createTask: (input: {
    projectId: string;
    scopeId: string | null;
    title: string;
    description: string;
    priority: Task['priority'];
  }) => invoke<Task>('create_task', { input }),
  updateTask: (
    taskId: string,
    input: {
      projectId: string;
      scopeId: string | null;
      title: string;
      description: string;
      priority: Task['priority'];
    },
  ) => invoke<Task>('update_task', { taskId, input }),
  deleteTask: (taskId: string) => invoke<void>('delete_task', { taskId }),
  transitionTask: (taskId: string, toStatus: Task['status']) =>
    invoke<Task>('transition_task', { taskId, toStatus }),
  queueTaskExecution: (taskId: string, confirmBroadScope: boolean) =>
    invoke<TaskRun>('queue_task_execution', { taskId, confirmBroadScope }),
  taskRuns: (taskId: string) => invoke<TaskRun[]>('list_task_runs', { taskId }),
  respondToRunPermission: (
    runId: string,
    permissionId: string,
    decision: 'allow_once' | 'reject',
  ) => invoke<TaskRun>('respond_to_run_permission', { runId, permissionId, decision }),
  cancelTaskRun: (runId: string) => invoke<TaskRun>('cancel_task_run', { runId }),
  reconcileTaskRun: (runId: string, confirmStopped: boolean) =>
    invoke<TaskRun>('reconcile_task_run', { runId, confirmStopped }),
  triageTask: (taskId: string) =>
    invoke<{ task: Task; result: TriageResult }>('triage_task', { taskId }),
  taskTriage: (taskId: string) => invoke<TriageResult | null>('get_task_triage', { taskId }),
  taskGlpiContext: (taskId: string) =>
    invoke<LinkedGlpiTicketContext | null>('get_task_glpi_context', { taskId }),
  downloadTaskGlpiDocument: (taskId: string, documentId: number) =>
    invoke<DownloadedGlpiDocument>('download_task_glpi_document', { taskId, documentId }),
  postGlpiContextQuestion: (taskId: string, content: string) =>
    invoke<number>('post_glpi_context_question', {
      taskId,
      content,
      confirmPublicMessage: true,
    }),
  settings: () => invoke<AppSettings>('get_settings'),
  saveSetting: (key: string, value: string) => invoke<void>('save_setting', { key, value }),
  githubAppAccount: () => invoke<GitHubAccount | null>('github_app_account'),
  githubAppBeginDeviceFlow: () => invoke<DeviceFlowPrompt>('github_app_begin_device_flow'),
  githubAppPollDeviceFlow: () => invoke<DeviceFlowPollResult>('github_app_poll_device_flow'),
  githubAppLogout: () => invoke<void>('github_app_logout'),
  githubOrganizationProjects: (organization: string) =>
    invoke<GitHubProject[]>('list_github_organization_projects', { organization }),
  githubProjectFields: (organization: string, projectNumber: number) =>
    invoke<GitHubProjectField[]>('list_github_project_fields', { organization, projectNumber }),
  githubProjectSources: (projectId?: string) =>
    invoke<GitHubProjectSource[]>('list_github_project_sources', { projectId: projectId ?? null }),
  saveGitHubProjectSource: (input: {
    projectId: string;
    organization: string;
    projectNumber: number;
    statusFieldId: string;
    pendingOptionId: string;
    executionScopeId: string;
  }) => invoke<GitHubProjectSource>('save_github_project_source', { input }),
  deleteGitHubProjectSource: (projectId: string) =>
    invoke<void>('delete_github_project_source', { projectId }),
  syncGitHubProjectSource: (projectId: string) =>
    invoke<GitHubProjectSyncResult>('sync_github_project_source', { projectId }),
  sourceConnections: (projectId?: string) =>
    invoke<SourceConnection[]>('list_source_connections', { projectId: projectId ?? null }),
  connectGitHub: (input: { projectId: string; owner: string; repository: string; token: string }) =>
    invoke<SourceConnection>('connect_github', { input }),
  connectGlpi: (input: {
    projectId: string;
    apiEndpoint: string;
    userToken: string;
    appToken: string;
  }) => invoke<SourceConnection>('connect_glpi', { input }),
  deleteSourceConnection: (connectionId: string) =>
    invoke<void>('delete_source_connection', { connectionId }),
  syncSourceConnection: (connectionId: string) =>
    invoke<SourceSyncResult>('sync_source_connection', { connectionId }),
  verifyOpenCode: () => invoke<OpenCodeStatus>('verify_opencode'),
  openCodeSessions: () => invoke<OpenCodeSession[]>('list_opencode_sessions'),
};

export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  )
    return error.message;
  return 'Something went wrong. Please try again.';
}
