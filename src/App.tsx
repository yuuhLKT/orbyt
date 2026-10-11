import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  ArrowDownLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  CirclePlus,
  Command,
  FolderKanban,
  FolderOpen,
  Gauge,
  GitBranch,
  Paperclip,
  ExternalLink,
  Layers3,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { api, errorMessage } from './lib/commands';
import { availableTransitions } from './lib/task-rules';
import type {
  ExecutionScope,
  DeviceFlowPrompt,
  GitHubProjectField,
  OpenCodeSession,
  Project,
  Task,
  TaskRun,
  TaskRunState,
  TaskStatus,
  TriageResult,
} from './types/domain';

const keys = {
  projects: ['projects'],
  tasks: ['tasks'],
  settings: ['settings'],
  sessions: ['sessions'],
};
const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;

function transitionLabel(status: TaskStatus) {
  const labels: Partial<Record<TaskStatus, string>> = {
    pending: 'Return to pending',
    triaging: 'Mark triaging',
    awaiting_context: 'Request more context',
    awaiting_approval: 'Request approval',
    awaiting_review: 'Mark ready for review',
    completed: 'Mark completed',
    blocked: 'Mark blocked',
    failed: 'Mark failed',
    canceled: 'Cancel task',
  };
  return labels[status] ?? `Mark ${formatStatus(status)}`;
}

function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: api.projects });
}
function useTasks() {
  return useQuery({
    queryKey: keys.tasks,
    queryFn: () => api.tasks(),
    // Also lets the backend reconcile triage work interrupted by an app restart.
    refetchInterval: 30_000,
  });
}
function useAppSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: api.settings });
}

function App() {
  return (
    <div className="app-shell">
      <ReviewNotifications />
      <GitHubProjectSyncScheduler />
      <Sidebar />
      <div className="app-main">
        <Topbar />
        <main className="page-area">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:projectId" element={<ProjectDetail />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function ReviewNotifications() {
  const { data: tasks, isSuccess } = useTasks();
  const hasBaseline = useRef(false);

  useEffect(() => {
    if (!isSuccess || !tasks) return;
    const notificationKey = 'orbyt.review-notification-task-ids';
    let notifiedIds: Set<string>;
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(notificationKey) ?? '[]');
      notifiedIds = new Set(
        Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [],
      );
    } catch {
      notifiedIds = new Set();
    }
    if (!hasBaseline.current) {
      hasBaseline.current = true;
    }

    const completedRuns = tasks.filter(
      (task) =>
        task.status === 'awaiting_review' && !notifiedIds.has(`${task.id}:${task.updatedAt}`),
    );
    if (completedRuns.length === 0) return;
    for (const task of completedRuns) notifiedIds.add(`${task.id}:${task.updatedAt}`);
    try {
      localStorage.setItem(notificationKey, JSON.stringify([...notifiedIds].slice(-1000)));
    } catch {
      // Notification delivery remains best-effort when local storage is unavailable.
    }

    void (async () => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === 'granted';
        if (!granted) return;

        for (const task of completedRuns) {
          sendNotification({
            title: 'Orbyt: revisão pronta',
            body: task.title,
          });
        }
      } catch {
        // Notifications are a convenience; a platform permission failure must not affect tasks.
      }
    })();
  }, [isSuccess, tasks]);

  return null;
}

function Sidebar() {
  const { data: projects = [] } = useProjects();
  const { data: tasks = [] } = useTasks();
  const links = [
    { to: '/', label: 'Overview', icon: Gauge, end: true },
    { to: '/projects', label: 'Projects', icon: FolderKanban },
    { to: '/tasks', label: 'Tasks', icon: Layers3 },
    { to: '/sessions', label: 'Sessions', icon: SquareTerminal },
  ];
  return (
    <aside className="sidebar">
      <Link to="/" className="brand">
        <span className="brand-mark">
          <Sparkles size={17} />
        </span>
        <span>orbyt</span>
        <span className="brand-version">0.1</span>
      </Link>
      <div className="workspace-switch">
        <span className="workspace-avatar">Y</span>
        <span className="workspace-copy">
          <strong>Local workspace</strong>
          <small>Personal environment</small>
        </span>
        <ChevronDown size={15} />
      </div>
      <div className="side-section-label">WORKSPACE</div>
      <nav className="side-nav">
        {links.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            <Icon size={17} strokeWidth={1.8} />
            <span>{label}</span>
            {label === 'Tasks' && tasks.length > 0 && (
              <span className="nav-count">{tasks.length}</span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="side-project-heading">
        <span className="side-section-label">YOUR PROJECTS</span>
        <Link to="/projects" aria-label="Add project">
          <Plus size={15} />
        </Link>
      </div>
      <div className="project-nav-list">
        {projects.slice(0, 5).map((project) => (
          <Link className="project-nav-item" key={project.id} to={`/projects/${project.id}`}>
            <span className="project-dot" />
            {project.name}
          </Link>
        ))}
        {projects.length === 0 && <span className="sidebar-muted">No projects yet</span>}
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-tip">
          <span className="tip-icon">
            <ShieldCheck size={16} />
          </span>
          <strong>You're in control</strong>
          <p>Every implementation requires your approval.</p>
        </div>
        <NavLink
          to="/settings"
          className={({ isActive }) => `nav-link settings-link${isActive ? ' active' : ''}`}
        >
          <Settings2 size={17} />
          <span>Settings</span>
        </NavLink>
        <div className="sidebar-footer">
          <span className="online-dot" /> Local-first by design{' '}
          <span className="footer-shortcut">⌘ K</span>
        </div>
      </div>
    </aside>
  );
}

function Topbar() {
  const { data: settings = {} } = useAppSettings();
  const connected = settings['opencode_last_connected'] === 'true';
  return (
    <header className="topbar">
      <div className="breadcrumb">
        <span>Orbyt</span>
        <span className="crumb-slash">/</span>
        <span className="crumb-current">Development control center</span>
      </div>
      <div className="topbar-actions">
        <Link to="/settings" className={`connection-pill ${connected ? 'is-connected' : ''}`}>
          <span className="connection-dot" />
          OpenCode {connected ? 'connected' : 'not verified'}
        </Link>
        <button className="icon-button" aria-label="Help">
          <CircleHelp size={17} />
        </button>
        <div className="user-avatar">Y</div>
      </div>
    </header>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="heading-action">{action}</div>}
    </div>
  );
}

function Overview() {
  const { data: projects = [], isLoading: loadingProjects, error: projectsError } = useProjects();
  const { data: tasks = [], isLoading: loadingTasks, error: tasksError } = useTasks();
  const isLoading = loadingProjects || loadingTasks;
  const counts = useMemo(
    () => ({
      pending: tasks.filter((task) =>
        ['pending', 'triaging', 'awaiting_context', 'needs_reconciliation'].includes(task.status),
      ).length,
      approval: tasks.filter((task) => task.status === 'awaiting_approval').length,
      sessions: tasks.filter((task) => task.status === 'running').length,
      queued: tasks.filter((task) => task.status === 'queued').length,
      review: tasks.filter((task) => task.status === 'awaiting_review').length,
    }),
    [tasks],
  );
  return (
    <>
      <PageHeading
        eyebrow="DEVELOPMENT CONTROL CENTER"
        title="Your workspace"
        description="Here's what's happening across your development workspace."
        action={
          <Link className="button button-primary" to="/tasks">
            <Plus size={16} />
            New task
          </Link>
        }
      />
      {(projectsError || tasksError) && (
        <ErrorBanner message={errorMessage(projectsError ?? tasksError)} />
      )}
      <section className="metrics-grid" aria-label="Workspace summary">
        <MetricCard
          icon={<FolderKanban size={17} />}
          label="Projects"
          value={projects.length}
          note="Registered workspaces"
          tone="blue"
        />
        <MetricCard
          icon={<Layers3 size={17} />}
          label="Needs attention"
          value={counts.pending}
          note="Tasks to triage"
          tone="amber"
        />
        <MetricCard
          icon={<ShieldCheck size={17} />}
          label="Needs approval"
          value={counts.approval}
          note="Waiting for your approval"
          tone="amber"
        />
        <MetricCard
          icon={<Bot size={17} />}
          label="Active sessions"
          value={counts.sessions}
          note="OpenCode sessions"
          tone="violet"
        />
        <MetricCard
          icon={<Activity size={17} />}
          label="Queued"
          value={counts.queued}
          note="Approved tasks"
          tone="blue"
        />
        <MetricCard
          icon={<Check size={17} />}
          label="Ready for review"
          value={counts.review}
          note="Awaiting your review"
          tone="green"
        />
      </section>
      {isLoading ? (
        <LoadingState label="Loading your workspace" />
      ) : (
        <div className="overview-grid">
          <section className="panel activity-panel">
            <div className="panel-heading">
              <div>
                <h2>Task queue</h2>
                <p>Your work, at a glance</p>
              </div>
              <Link className="text-link" to="/tasks">
                All tasks <ArrowRight size={14} />
              </Link>
            </div>
            {tasks.length ? (
              <TaskTable tasks={tasks.slice(0, 5)} projects={projects} />
            ) : (
              <EmptyState
                icon={<Layers3 size={20} />}
                title="Your queue is clear"
                description="Create a task to start organizing your development work."
                action={
                  <Link to="/tasks" className="button button-secondary button-small">
                    <Plus size={15} />
                    Create a task
                  </Link>
                }
              />
            )}
          </section>
          <aside className="overview-right">
            <section className="panel project-panel">
              <div className="panel-heading">
                <div>
                  <h2>Projects</h2>
                  <p>Local workspaces</p>
                </div>
                <Link to="/projects" className="icon-button subtle" aria-label="Manage projects">
                  <ArrowRight size={16} />
                </Link>
              </div>
              {projects.length ? (
                <div className="mini-project-list">
                  {projects.slice(0, 4).map((project) => (
                    <Link to={`/projects/${project.id}`} className="mini-project" key={project.id}>
                      <div className="mini-project-icon">
                        <GitBranch size={16} />
                      </div>
                      <div className="mini-project-copy">
                        <strong>{project.name}</strong>
                        <span>{project.directory}</span>
                      </div>
                      <ArrowRight size={14} />
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="mini-empty">
                  <p>No project directories registered.</p>
                  <Link className="text-link" to="/projects">
                    Add your first project <ArrowRight size={14} />
                  </Link>
                </div>
              )}
              <Link className="project-add-link" to="/projects">
                <CirclePlus size={15} />
                Add a project
              </Link>
            </section>
            <OpenCodeCard />
          </aside>
        </div>
      )}
    </>
  );
}

function MetricCard({
  icon,
  label,
  value,
  note,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  note: string;
  tone: string;
}) {
  return (
    <article className="metric-card">
      <div className="metric-top">
        <span className={`metric-icon ${tone}`}>{icon}</span>
        <span className="metric-label">{label}</span>
        <MoreHorizontal size={17} className="metric-more" />
      </div>
      <div className="metric-value">{value.toString().padStart(2, '0')}</div>
      <div className="metric-note">{note}</div>
    </article>
  );
}

function OpenCodeCard() {
  const { data: settings = {} } = useAppSettings();
  const connected = settings['opencode_last_connected'] === 'true';
  return (
    <section className="opencode-card">
      <div className="opencode-card-top">
        <span className="opencode-orbit">
          <Bot size={18} />
        </span>
        <span className={`status-tag ${connected ? 'success' : 'neutral'}`}>
          <span />
          {connected ? 'Connected' : 'Not verified'}
        </span>
      </div>
      <h3>OpenCode</h3>
      <p>
        {connected
          ? 'Your existing OpenCode installation is ready to connect.'
          : 'Connect your existing installation to power future agent workflows.'}
      </p>
      <Link to="/settings" className="opencode-link">
        {connected ? 'Connection settings' : 'Set up connection'}
        <ArrowRight size={14} />
      </Link>
      <div className="opencode-decoration decoration-one" />
      <div className="opencode-decoration decoration-two" />
    </section>
  );
}

function Projects() {
  const queryClient = useQueryClient();
  const { data: projects = [], isLoading, error } = useProjects();
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState('');
  const filtered = projects.filter((p) =>
    `${p.name} ${p.directory}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const remove = useMutation({
    mutationFn: api.deleteProject,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
    },
  });
  return (
    <>
      <PageHeading
        eyebrow="WORKSPACE"
        title="Projects"
        description="Manage local directories and define safe execution scopes."
        action={
          <button className="button button-primary" onClick={() => setShowForm(true)}>
            <Plus size={16} />
            Add project
          </button>
        }
      />
      {error && <ErrorBanner message={errorMessage(error)} />}
      {remove.error && <ErrorBanner message={errorMessage(remove.error)} />}
      <div className="toolbar">
        <div className="search-box">
          <Search size={16} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search projects..."
            aria-label="Search projects"
          />
        </div>
        <span className="result-count">
          {projects.length} {projects.length === 1 ? 'project' : 'projects'}
        </span>
      </div>
      {isLoading ? (
        <LoadingState label="Loading projects" />
      ) : filtered.length === 0 ? (
        <EmptyState
          className="large-empty"
          icon={<FolderKanban size={22} />}
          title={projects.length ? 'No matching projects' : 'No projects yet'}
          description={
            projects.length
              ? 'Try a different search term.'
              : 'Register a local workspace to start organizing development tasks.'
          }
          action={
            !projects.length ? (
              <button className="button button-primary" onClick={() => setShowForm(true)}>
                <Plus size={16} />
                Add your first project
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="projects-grid">
          {filtered.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onDelete={() => {
                if (confirm(`Remove ${project.name} from Orbyt? Its files will not be deleted.`))
                  remove.mutate(project.id);
              }}
            />
          ))}
        </div>
      )}
      {showForm && <ProjectForm onClose={() => setShowForm(false)} />}
    </>
  );
}

function ProjectCard({ project, onDelete }: { project: Project; onDelete: () => void }) {
  const {
    data: scopes,
    isLoading: scopesLoading,
    error: scopesError,
  } = useQuery({
    queryKey: ['scopes', project.id],
    queryFn: () => api.scopes(project.id),
  });
  return (
    <article className="project-card">
      <div className="project-card-top">
        <div className="project-icon">
          <GitBranch size={19} />
        </div>
        <button
          className="icon-button subtle"
          onClick={onDelete}
          aria-label={`Remove ${project.name}`}
        >
          <Trash2 size={15} />
        </button>
      </div>
      <Link className="project-card-title" to={`/projects/${project.id}`}>
        {project.name}
        <ArrowRight size={15} />
      </Link>
      <p className="project-description">{project.description || 'No description added yet.'}</p>
      <div className="project-path">
        <FolderOpen size={14} />
        <span title={project.directory}>{project.directory}</span>
      </div>
      <div className="project-card-footer">
        <span title={scopesError ? errorMessage(scopesError) : undefined}>
          <Layers3 size={14} />
          {scopes !== undefined
            ? `${scopes.length} ${scopes.length === 1 ? 'scope' : 'scopes'}`
            : scopesLoading
              ? 'Loading scopes…'
              : 'Scopes unavailable'}
        </span>
        <span>
          <Activity size={14} />
          Up to {project.maxConcurrentSessions} sessions
        </span>
      </div>
    </article>
  );
}

function ProjectForm({ onClose, project }: { onClose: () => void; project?: Project }) {
  const queryClient = useQueryClient();
  const { data: settings = {} } = useAppSettings();
  const [directory, setDirectory] = useState(project?.directory ?? '');
  const [concurrencyOverride, setConcurrencyOverride] = useState<number | null>(
    project?.maxConcurrentSessions ?? null,
  );
  const [message, setMessage] = useState('');
  const concurrency =
    concurrencyOverride ??
    Number(settings['max_concurrent_sessions'] ?? String(DEFAULT_MAX_CONCURRENT_SESSIONS));
  const save = useMutation({
    mutationFn: (input: {
      name: string;
      description: string;
      directory: string;
      maxConcurrentSessions: number;
    }) => (project ? api.updateProject(project.id, input) : api.createProject(input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      onClose();
    },
    onError: (error) => setMessage(errorMessage(error)),
  });
  async function chooseDirectory() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choose a project directory',
      });
      if (typeof selected === 'string') setDirectory(selected);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save.mutate({
      name: String(data.get('name')).trim(),
      description: String(data.get('description')).trim(),
      directory,
      maxConcurrentSessions: Number(data.get('concurrency')),
    });
  }
  return (
    <Modal
      title={project ? 'Edit project' : 'Add a project'}
      subtitle="Connect a local workspace. Orbyt never moves or copies your source files."
      onClose={onClose}
    >
      <form onSubmit={submit} className="form-stack">
        <label className="field-label">
          Project name
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={project?.name}
            placeholder="e.g. GLPI"
          />
        </label>
        <label className="field-label">
          Description <span className="optional">Optional</span>
          <textarea
            name="description"
            rows={2}
            maxLength={500}
            defaultValue={project?.description}
            placeholder="What are you building?"
          />
        </label>
        <div className="field-label">
          Project directory
          <div className="directory-input">
            <input
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
              required
              placeholder="Select an existing folder"
            />
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void chooseDirectory()}
            >
              <FolderOpen size={15} />
              Browse
            </button>
          </div>
          <span className="field-hint">
            Select the actual local project root. Files remain in place.
          </span>
        </div>
        <label className="field-label">
          Maximum concurrent sessions
          <select
            name="concurrency"
            value={concurrency}
            onChange={(event) => setConcurrencyOverride(Number(event.target.value))}
          >
            {[1, 2, 3, 4, 5, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? 'session' : 'sessions'}
              </option>
            ))}
          </select>
          <span className="field-hint">Tasks targeting overlapping scopes will be serialized.</span>
        </label>
        {message && (
          <div className="form-error">
            <AlertCircle size={15} />
            {message}
          </div>
        )}
        <div className="modal-actions">
          <button className="button button-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={save.isPending || !directory}>
            {save.isPending ? (
              <LoaderCircle className="spin" size={15} />
            ) : project ? (
              <Check size={15} />
            ) : (
              <Plus size={15} />
            )}
            {project ? 'Save project' : 'Register project'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectDetail() {
  const { projectId = '' } = useParams();
  const queryClient = useQueryClient();
  const {
    data: projects = [],
    isLoading: projectsLoading,
    isFetching: projectsFetching,
    error: projectsError,
  } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const {
    data: scopes = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['scopes', projectId],
    queryFn: () => api.scopes(projectId),
    enabled: Boolean(projectId),
  });
  const [showForm, setShowForm] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const remove = useMutation({
    mutationFn: api.deleteScope,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['scopes', projectId] }),
  });
  if (!project && (projectsLoading || projectsFetching))
    return (
      <>
        <PageHeading title="Loading project" />
        <LoadingState label="Loading project details" />
      </>
    );
  if (!project && projectsError)
    return (
      <>
        <PageHeading
          title="Could not load project"
          description="Orbyt could not retrieve the registered projects."
        />
        <ErrorBanner message={errorMessage(projectsError)} />
        <Link className="button button-secondary" to="/projects">
          Back to projects
        </Link>
      </>
    );
  if (!project)
    return (
      <>
        <PageHeading
          title="Project not found"
          description="This project may have been removed from Orbyt."
        />
        <Link className="button button-secondary" to="/projects">
          Back to projects
        </Link>
      </>
    );
  return (
    <>
      <div className="back-link-row">
        <Link to="/projects" className="text-link">
          <ArrowDownLeft size={14} />
          All projects
        </Link>
      </div>
      <PageHeading
        eyebrow="PROJECT SETTINGS"
        title={project.name}
        description={project.directory}
        action={
          <div className="button-row">
            <button className="button button-secondary" onClick={() => setShowEdit(true)}>
              <Settings2 size={15} />
              Edit project
            </button>
            <button className="button button-primary" onClick={() => setShowForm(true)}>
              <Plus size={16} />
              Add execution scope
            </button>
          </div>
        }
      />
      <div className="detail-summary">
        <div>
          <span className="summary-label">Concurrency limit</span>
          <strong>{project.maxConcurrentSessions} sessions</strong>
        </div>
        <div>
          <span className="summary-label">Approval policy</span>
          <strong>
            <ShieldCheck size={15} /> Manual for local tasks · automatic for configured GitHub
            intake
          </strong>
        </div>
        <div>
          <span className="summary-label">Execution mode</span>
          <strong>Existing workspace · no copies</strong>
        </div>
      </div>
      <section className="panel scopes-panel">
        <div className="panel-heading">
          <div>
            <h2>Execution scopes</h2>
            <p>
              Directories an approved task may target. Scope selection does not itself isolate agent
              writes.
            </p>
          </div>
        </div>
        {error && <ErrorBanner message={errorMessage(error)} />}
        {remove.error && <ErrorBanner message={errorMessage(remove.error)} />}
        {isLoading ? (
          <LoadingState label="Loading execution scopes" />
        ) : scopes.length ? (
          <div className="scope-list">
            {scopes.map((scope) => (
              <ScopeRow
                key={scope.id}
                scope={scope}
                onDelete={() => {
                  if (confirm(`Remove the “${scope.name}” scope?`)) remove.mutate(scope.id);
                }}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<ShieldCheck size={20} />}
            title="No execution scopes defined"
            description="Add target directories such as plugins/monitoring. Shared core files stay outside task scope."
            action={
              <button
                className="button button-secondary button-small"
                onClick={() => setShowForm(true)}
              >
                <Plus size={15} />
                Add a scope
              </button>
            }
          />
        )}
      </section>
      {showForm && <ScopeForm project={project} onClose={() => setShowForm(false)} />}
      {showEdit && <ProjectForm project={project} onClose={() => setShowEdit(false)} />}
    </>
  );
}

function ScopeRow({ scope, onDelete }: { scope: ExecutionScope; onDelete: () => void }) {
  return (
    <div className="scope-row">
      <div className="scope-icon">
        <FolderOpen size={16} />
      </div>
      <div className="scope-name">
        <strong>{scope.name}</strong>
        <span>{scope.relativeDirectory}</span>
      </div>
      <div className="scope-access">
        <span className={scope.readAccess ? 'access-enabled' : ''}>
          <Search size={13} />
          Read
        </span>
        <span className={scope.writeAccess ? 'access-write' : ''}>
          <GitBranch size={13} />
          Write
        </span>
      </div>
      <span className="scope-policy">
        <span className="online-dot" />
        Serialize conflicts
      </span>
      <button className="icon-button subtle" onClick={onDelete} aria-label={`Remove ${scope.name}`}>
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function ScopeForm({ project, onClose }: { project: Project; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const create = useMutation({
    mutationFn: api.createScope,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['scopes', project.id] });
      onClose();
    },
    onError: (error) => setMessage(errorMessage(error)),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({
      projectId: project.id,
      name: String(data.get('name')).trim(),
      relativeDirectory: String(data.get('directory')).trim(),
      readAccess: true,
      writeAccess: data.get('write') === 'on',
    });
  }
  return (
    <Modal
      title="Add execution scope"
      subtitle="Scopes are relative to this project and must resolve to an existing directory."
      onClose={onClose}
    >
      <form className="form-stack" onSubmit={submit}>
        <label className="field-label">
          Scope name
          <input name="name" required maxLength={100} placeholder="e.g. Monitoring plugin" />
        </label>
        <label className="field-label">
          Relative directory
          <input name="directory" required placeholder="plugins/monitoring" />
          <span className="field-hint">
            Path traversal and symlink escapes are rejected by the native backend.
          </span>
        </label>
        <label className="check-field">
          <input type="checkbox" checked readOnly />
          <span>
            <strong>Read access</strong>
            <small>Agents may need to inspect the shared project source.</small>
          </span>
        </label>
        <label className="check-field">
          <input type="checkbox" name="write" defaultChecked />
          <span>
            <strong>Write access</strong>
            <small>This is the approved target for future implementation sessions.</small>
          </span>
        </label>
        <div className="scope-security-note">
          <TriangleAlert size={15} />
          <span>
            An approved task can start an OpenCode implementation in this scope. Scope boundaries
            coordinate Orbyt runs but do not isolate filesystem access at the operating-system
            level.
          </span>
        </div>
        {message && (
          <div className="form-error">
            <AlertCircle size={15} />
            {message}
          </div>
        )}
        <div className="modal-actions">
          <button className="button button-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={create.isPending}>
            {create.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}Add
            scope
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Tasks() {
  const queryClient = useQueryClient();
  const { data: tasks = [], isLoading, error } = useTasks();
  const { data: projects = [] } = useProjects();
  const [showForm, setShowForm] = useState(false);
  const [editingTask, setEditingTask] = useState<Task>();
  const [projectFilter, setProjectFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const remove = useMutation({
    mutationFn: api.deleteTask,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.tasks }),
  });
  const visible = tasks.filter(
    (task) =>
      (projectFilter === 'all' || task.projectId === projectFilter) &&
      (statusFilter === 'all' || task.status === statusFilter),
  );
  return (
    <>
      <PageHeading
        eyebrow="WORK QUEUE"
        title="Tasks"
        description="Keep development requests organized across your local projects."
        action={
          <button
            className="button button-primary"
            onClick={() => {
              setEditingTask(undefined);
              setShowForm(true);
            }}
          >
            <Plus size={16} />
            New task
          </button>
        }
      />
      {(error || remove.error) && <ErrorBanner message={errorMessage(error ?? remove.error)} />}
      <div className="session-notice" role="note">
        <ShieldCheck size={17} />
        <div>
          <strong>Supervised implementation</strong>
          <p>
            Local tasks wait for approval. GitHub Project tasks can start automatically after
            sufficient-context triage in their configured writable scope. OpenCode rules that
            already allow a tool action can let it run without a separate permission request.
            Project scopes are scheduler boundaries, not OS-level filesystem isolation. Triage sends
            the Issue text and linked GLPI ticket text, public follow-ups, and attachment metadata
            to the configured model; it does not read project files or attachment bytes.
          </p>
        </div>
      </div>
      <div className="toolbar task-toolbar">
        <div className="filter-group">
          <label className="select-filter">
            <span>Project</span>
            <select
              aria-label="Filter by project"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            >
              <option value="all">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="select-filter">
            <span>Status</span>
            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              {[
                'pending',
                'triaging',
                'awaiting_context',
                'awaiting_approval',
                'needs_reconciliation',
                'queued',
                'running',
                'awaiting_review',
                'completed',
                'blocked',
                'failed',
                'canceled',
              ].map((status) => (
                <option value={status} key={status}>
                  {formatStatus(status)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <span className="result-count">
          {visible.length} {visible.length === 1 ? 'task' : 'tasks'}
        </span>
      </div>
      {isLoading ? (
        <LoadingState label="Loading tasks" />
      ) : visible.length === 0 ? (
        <EmptyState
          className="large-empty"
          icon={<Layers3 size={22} />}
          title={tasks.length ? 'No tasks match these filters' : 'Start with a task'}
          description={
            tasks.length
              ? 'Try changing the selected filters.'
              : 'Add a manual development task and attach it to a project and execution scope.'
          }
          action={
            tasks.length ? undefined : (
              <button
                className="button button-primary"
                onClick={() => {
                  setEditingTask(undefined);
                  setShowForm(true);
                }}
              >
                <Plus size={16} />
                Create your first task
              </button>
            )
          }
        />
      ) : (
        <section className="panel task-list-panel">
          <div className="task-list-head">
            <span>TASK</span>
            <span>PROJECT / SCOPE</span>
            <span>PRIORITY</span>
            <span>STATUS</span>
            <span />
          </div>
          {visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              projects={projects}
              onEdit={() => {
                setEditingTask(task);
                setShowForm(true);
              }}
              onDelete={() => {
                if (confirm(`Delete task “${task.title}”?`)) remove.mutate(task.id);
              }}
            />
          ))}
        </section>
      )}
      {showForm && (
        <TaskForm
          task={editingTask}
          projects={projects}
          onClose={() => {
            setShowForm(false);
            setEditingTask(undefined);
          }}
        />
      )}
    </>
  );
}

function TaskRow({
  task,
  projects,
  onDelete,
  onEdit,
}: {
  task: Task;
  projects: Project[];
  onDelete: () => void;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const project = projects.find((item) => item.id === task.projectId);
  const {
    data: scopes = [],
    isLoading: scopesLoading,
    error: scopesError,
  } = useQuery({
    queryKey: ['scopes', task.projectId],
    queryFn: () => api.scopes(task.projectId),
    enabled: Boolean(task.projectId),
  });
  const scope = scopes.find((item) => item.id === task.scopeId);
  const { data: triageResult = null, error: triageLoadError } = useQuery({
    queryKey: ['task-triage', task.id],
    queryFn: () => api.taskTriage(task.id),
  });
  const triage = useMutation({
    mutationFn: () => api.triageTask(task.id),
    onSuccess: ({ task: updatedTask, result }) => {
      queryClient.setQueryData(['task-triage', task.id], result);
      queryClient.setQueryData<Task[]>(keys.tasks, (current) =>
        current?.map((item) => (item.id === updatedTask.id ? updatedTask : item)),
      );
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: keys.tasks }),
  });
  const transition = useMutation({
    mutationFn: (toStatus: TaskStatus) => api.transitionTask(task.id, toStatus),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.tasks }),
  });
  const [confirmBroadScope, setConfirmBroadScope] = useState(false);
  const startExecution = useMutation({
    mutationFn: (confirmScope: boolean) => api.queueTaskExecution(task.id, confirmScope),
    onSuccess: (run) => {
      queryClient.setQueryData<TaskRun[]>(['task-runs', task.id], (current) => {
        const runs = current ?? [];
        return [run, ...runs.filter((item) => item.id !== run.id)];
      });
      setConfirmBroadScope(false);
      void queryClient.invalidateQueries({ queryKey: ['task-runs', task.id] });
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: keys.tasks }),
  });
  const canTriage = ['pending', 'awaiting_context', 'failed'].includes(task.status);
  const canStartExecution =
    task.status === 'awaiting_approval' && (task.scopeId === null || Boolean(scope?.writeAccess));
  return (
    <>
      <div className="task-row">
        <div className="task-title-cell">
          <span className="task-source-icon">
            {task.source === 'github' ? <GitBranch size={15} /> : <Layers3 size={15} />}
          </span>
          <div>
            <strong>{task.title}</strong>
            <span>{task.description || 'No additional description'}</span>
            {task.source !== 'manual' && (
              <small className="task-source-reference">
                {task.source === 'github' ? 'GitHub' : 'GLPI'} · {task.externalReference}
                {task.externalStatus ? ` · remote: ${task.externalStatus}` : ''}
              </small>
            )}
          </div>
        </div>
        <div className="task-project-cell">
          <strong>{project?.name ?? 'Unknown project'}</strong>
          <span>{scope?.relativeDirectory ?? 'No scope selected'}</span>
        </div>
        <span className={`priority priority-${task.priority}`}>
          <i />
          {task.priority}
        </span>
        <span className={`task-status status-${task.status}`}>
          <i />
          {formatStatus(task.status)}
        </span>
        <div className="task-row-actions">
          <button
            className="icon-button subtle task-delete"
            onClick={onEdit}
            aria-label={`Edit ${task.title}`}
          >
            <Settings2 size={14} />
          </button>
          <button
            className="icon-button subtle task-delete"
            onClick={onDelete}
            aria-label={`Delete ${task.title}`}
          >
            <Trash2 size={14} />
          </button>
          <details>
            <summary aria-label={`Actions for ${task.title}`}>Actions</summary>
            <div className="form-stack" style={{ minWidth: 230, padding: 10 }}>
              {canTriage && (
                <button
                  className="button button-primary button-small"
                  disabled={triage.isPending || transition.isPending}
                  onClick={() => triage.mutate()}
                >
                  {triage.isPending ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  {triage.isPending ? 'Triaging…' : 'Run triage'}
                </button>
              )}
              {canStartExecution && (
                <button
                  className="button button-primary button-small"
                  disabled={startExecution.isPending || triage.isPending || transition.isPending}
                  onClick={() => {
                    if (task.scopeId === null) setConfirmBroadScope(true);
                    else startExecution.mutate(false);
                  }}
                >
                  {startExecution.isPending ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <SquareTerminal size={14} />
                  )}
                  {startExecution.isPending ? 'Starting…' : 'Approve and start implementation'}
                </button>
              )}
              {task.status === 'awaiting_approval' &&
                task.scopeId !== null &&
                !canStartExecution &&
                !scopesError && (
                  <p className="field-hint" role="status">
                    {scopesLoading
                      ? 'Checking the assigned execution scope…'
                      : scope
                        ? 'This scope is read-only. Choose a write-enabled scope before starting implementation.'
                        : 'The assigned scope is unavailable. Edit this task and choose an available scope.'}
                  </p>
                )}
              {availableTransitions(task.status)
                .filter((nextStatus) => !['triaging', 'queued', 'running'].includes(nextStatus))
                .map((nextStatus) => (
                  <button
                    className="button button-secondary button-small"
                    key={nextStatus}
                    disabled={triage.isPending || transition.isPending || startExecution.isPending}
                    onClick={() => transition.mutate(nextStatus)}
                  >
                    {transition.isPending && transition.variables === nextStatus ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : null}
                    {transitionLabel(nextStatus)}
                  </button>
                ))}
            </div>
          </details>
        </div>
      </div>
      {(scopesError ||
        triageLoadError ||
        triage.error ||
        transition.error ||
        startExecution.error) && (
        <div style={{ padding: '0 13px 10px' }}>
          <ErrorBanner
            message={errorMessage(
              scopesError ??
                triageLoadError ??
                triage.error ??
                transition.error ??
                startExecution.error,
            )}
          />
        </div>
      )}
      {triageResult && (
        <TriageReport result={triageResult} taskStatus={task.status as TaskStatus} />
      )}
      {task.linkedGlpiTicketId && <LinkedGlpiTicket task={task} triage={triageResult} />}
      <TaskExecutionRuns task={task} />
      {confirmBroadScope && (
        <Modal
          title="Confirm project-wide write scope"
          subtitle="This task does not have a specific execution scope selected."
          onClose={() => {
            if (!startExecution.isPending) setConfirmBroadScope(false);
          }}
        >
          <div className="form-stack">
            <div className="scope-security-note" role="note">
              <TriangleAlert size={16} />
              <span>
                The entire project directory will be the scheduler write lock for this run. A scope
                is a scheduling boundary only; it does not sandbox filesystem access or restrict
                OpenCode at the operating-system level.
              </span>
            </div>
            {startExecution.error && <ErrorBanner message={errorMessage(startExecution.error)} />}
            <div className="modal-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={startExecution.isPending}
                onClick={() => setConfirmBroadScope(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={startExecution.isPending}
                onClick={() => startExecution.mutate(true)}
              >
                {startExecution.isPending ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <SquareTerminal size={15} />
                )}
                Confirm broad scope and start
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function LinkedGlpiTicket({ task, triage }: { task: Task; triage: TriageResult | null }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [questionDraftState, setQuestionDraftState] = useState<{
    key: string;
    value: string;
  } | null>(null);
  const [notice, setNotice] = useState('');
  const [downloadedUrls, setDownloadedUrls] = useState<Record<number, string>>({});
  const downloadedUrlsRef = useRef(downloadedUrls);
  const ownFollowupIds = useRef(new Set<number>());
  const seenFollowupIds = useRef(new Set<number>());
  const hasFollowupBaseline = useRef(false);
  const draftKey = `${task.id}:${task.updatedAt}:${JSON.stringify(triage?.missingInformation ?? [])}`;
  const generatedQuestionDraft =
    task.status === 'awaiting_context' && triage?.missingInformation.length
      ? `Para conseguirmos iniciar esta solicitação, poderia esclarecer:\n${triage.missingInformation
          .map((item) => `- ${item}`)
          .join('\n')}`
      : '';
  const questionDraft =
    questionDraftState?.key === draftKey ? questionDraftState.value : generatedQuestionDraft;

  useEffect(() => {
    downloadedUrlsRef.current = downloadedUrls;
  }, [downloadedUrls]);

  const contextQuery = useQuery({
    queryKey: ['task-glpi-context', task.id],
    queryFn: () => api.taskGlpiContext(task.id),
    enabled: expanded,
    refetchInterval: expanded && task.status === 'awaiting_context' ? 30_000 : false,
  });
  const download = useMutation({
    mutationFn: (documentId: number) => api.downloadTaskGlpiDocument(task.id, documentId),
    onSuccess: (file) => {
      const oldUrl = downloadedUrlsRef.current[file.documentId];
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
      );
      setDownloadedUrls((current) => ({ ...current, [file.documentId]: url }));
    },
  });
  const postQuestion = useMutation({
    mutationFn: () => api.postGlpiContextQuestion(task.id, questionDraft),
    onSuccess: (followupId) => {
      ownFollowupIds.current.add(followupId);
      seenFollowupIds.current.add(followupId);
      setNotice(
        `Public GLPI follow-up #${followupId} posted. Orbyt will refresh this ticket while it is open.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['task-glpi-context', task.id] });
    },
  });
  const triageReply = useMutation({
    mutationFn: () => api.triageTask(task.id),
    onSuccess: ({ task: updatedTask, result }) => {
      queryClient.setQueryData(['task-triage', task.id], result);
      queryClient.setQueryData<Task[]>(keys.tasks, (current) =>
        current?.map((item) => (item.id === updatedTask.id ? updatedTask : item)),
      );
      setNotice('New public GLPI reply received and triaged. Review the updated task state.');
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
    },
    onError: (cause) => setNotice(`Could not triage the GLPI reply: ${errorMessage(cause)}`),
  });

  useEffect(() => {
    const followups = contextQuery.data?.context.publicFollowups;
    if (!followups) return;
    if (!hasFollowupBaseline.current) {
      followups.forEach((followup) => seenFollowupIds.current.add(followup.id));
      hasFollowupBaseline.current = true;
      return;
    }
    const newReply = followups.some(
      (followup) =>
        !seenFollowupIds.current.has(followup.id) && !ownFollowupIds.current.has(followup.id),
    );
    followups.forEach((followup) => seenFollowupIds.current.add(followup.id));
    if (newReply && task.status === 'awaiting_context' && !triageReply.isPending) {
      triageReply.mutate();
    }
  }, [contextQuery.data, task.status, triageReply]);

  useEffect(() => () => {
    Object.values(downloadedUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
  });

  const linked = contextQuery.data;
  const context = linked?.context;
  return (
    <section className="task-glpi-context" style={{ padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>GLPI ticket #{task.linkedGlpiTicketId}</strong>
        <button
          className="button button-secondary button-small"
          type="button"
          onClick={() => {
            setExpanded((current) => !current);
            setNotice('');
          }}
        >
          {expanded ? 'Hide ticket details' : 'Load ticket details'}
        </button>
        {linked?.ticketUrl && (
          <a href={linked.ticketUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={13} /> Open in GLPI
          </a>
        )}
      </div>
      {expanded && (
        <div className="form-stack" style={{ marginTop: 10 }}>
          {contextQuery.isLoading && <LoadingState label="Loading GLPI ticket context" />}
          {contextQuery.error && <ErrorBanner message={errorMessage(contextQuery.error)} />}
          {context && (
            <>
              <div>
                <strong>{context.ticket.title}</strong>
                <div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{context.ticket.content}</div>
              </div>
              <div>
                <strong>Public follow-ups</strong>
                {context.publicFollowups.length === 0 ? (
                  <p className="empty-copy">No public follow-ups.</p>
                ) : (
                  <div className="form-stack" style={{ marginTop: 6 }}>
                    {[...context.publicFollowups].reverse().map((followup) => (
                      <div className="panel" key={followup.id} style={{ padding: 10 }}>
                        <small>{followup.date ?? 'Date unavailable'}</small>
                        <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
                          {followup.content}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <strong>Attachments</strong>
                {context.documents.length === 0 ? (
                  <p className="empty-copy">No attachments found.</p>
                ) : (
                  <div className="form-stack" style={{ marginTop: 6 }}>
                    {context.documents.map((document) => (
                      <div key={document.id} className="source-connection-row">
                        <span>
                          <Paperclip size={14} /> {document.filename || document.name}
                          {document.mimeType ? ` · ${document.mimeType}` : ''}
                          {document.sizeBytes
                            ? ` · ${Math.ceil(document.sizeBytes / 1024)} KB`
                            : ''}
                        </span>
                        {downloadedUrls[document.id] ? (
                          document.mimeType?.startsWith('image/') ? (
                            <a href={downloadedUrls[document.id]} target="_blank" rel="noreferrer">
                              Preview image
                            </a>
                          ) : (
                            <a href={downloadedUrls[document.id]} download={document.filename}>
                              Download
                            </a>
                          )
                        ) : (
                          <button
                            className="button button-secondary button-small"
                            type="button"
                            disabled={download.isPending}
                            onClick={() => download.mutate(document.id)}
                          >
                            {download.isPending && download.variables === document.id
                              ? 'Loading…'
                              : 'Load attachment'}
                          </button>
                        )}
                        {downloadedUrls[document.id] && document.mimeType?.startsWith('image/') && (
                          <img
                            src={downloadedUrls[document.id]}
                            alt={document.filename || document.name}
                            style={{ maxWidth: '100%', maxHeight: 360, objectFit: 'contain' }}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <p className="field-hint">
                  Triage currently reads ticket text, public follow-ups, and attachment metadata.
                  Use the preview above to inspect images or files before approving work.
                </p>
              </div>
              {task.status === 'awaiting_context' && triage && (
                <div className="form-stack">
                  <label className="field-label">
                    Context request preview · public GLPI follow-up
                    <textarea
                      rows={5}
                      value={questionDraft}
                      onChange={(event) =>
                        setQuestionDraftState({ key: draftKey, value: event.target.value })
                      }
                    />
                  </label>
                  <span className="field-hint">
                    Review the exact text. Posting makes it visible to the ticket requester.
                  </span>
                  <button
                    className="button button-primary button-small"
                    type="button"
                    disabled={!questionDraft.trim() || postQuestion.isPending}
                    onClick={() => postQuestion.mutate()}
                  >
                    {postQuestion.isPending ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <ArrowRight size={14} />
                    )}
                    Post context request publicly
                  </button>
                  {postQuestion.error && (
                    <ErrorBanner
                      message={`${errorMessage(postQuestion.error)} If GLPI already shows the message, do not submit it again.`}
                    />
                  )}
                  {notice && (
                    <p className="field-hint" role="status">
                      {notice}
                    </p>
                  )}
                </div>
              )}
              {task.status === 'awaiting_context' && (
                <p className="field-hint">
                  Orbyt refreshes public follow-ups every 30 seconds while this panel is open and
                  reruns triage when a new reply arrives.
                </p>
              )}
              {context.followupsTruncated && (
                <p className="field-hint">
                  Some public follow-ups were omitted by the safety limit.
                </p>
              )}
              {context.documentsTruncated && (
                <p className="field-hint">
                  Some attachment metadata was omitted by the safety limit.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

const activeRunStates: TaskRunState[] = [
  'queued',
  'running',
  'waiting_permission',
  'cancel_requested',
];

function TaskExecutionRuns({ task }: { task: Task }) {
  const {
    data: runs = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['task-runs', task.id],
    queryFn: () => api.taskRuns(task.id),
    refetchInterval: (query) =>
      query.state.data?.some((run) => activeRunStates.includes(run.state)) ? 1500 : false,
  });
  const taskIndicatesActiveRun = task.status === 'queued' || task.status === 'running';

  if (error) {
    return (
      <div className="task-run-wrap">
        <ErrorBanner message={`Could not load implementation runs: ${errorMessage(error)}`} />
      </div>
    );
  }
  if (isLoading && taskIndicatesActiveRun) {
    return (
      <div className="task-run-wrap" role="status" aria-live="polite">
        <LoaderCircle className="spin" size={14} /> Loading implementation status…
      </div>
    );
  }
  if (runs.length === 0) {
    if (!taskIndicatesActiveRun) return null;
    return (
      <div className="task-run-wrap">
        <div className="error-banner" role="alert">
          <AlertCircle size={15} />
          <span>No run record is available for this active task state.</span>
          <button className="button button-secondary button-small" onClick={() => void refetch()}>
            Refresh status
          </button>
        </div>
      </div>
    );
  }
  return (
    <section className="task-run-wrap" aria-label={`Implementation runs for ${task.title}`}>
      {runs.map((run) => (
        <TaskRunCard key={run.id} run={run} />
      ))}
    </section>
  );
}

function TaskRunCard({ run }: { run: TaskRun }) {
  const queryClient = useQueryClient();
  const [showReconcile, setShowReconcile] = useState(false);
  const [confirmedStopped, setConfirmedStopped] = useState(false);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['task-runs', run.taskId] });
    void queryClient.invalidateQueries({ queryKey: keys.tasks });
  };
  const permission = useMutation({
    mutationFn: ({
      permissionId,
      decision,
    }: {
      permissionId: string;
      decision: 'allow_once' | 'reject';
    }) => api.respondToRunPermission(run.id, permissionId, decision),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelTaskRun(run.id),
    onSuccess: invalidate,
  });
  const reconcile = useMutation({
    mutationFn: () => api.reconcileTaskRun(run.id, true),
    onSuccess: () => {
      setShowReconcile(false);
      setConfirmedStopped(false);
      invalidate();
    },
  });
  const isWorking = permission.isPending || cancel.isPending || reconcile.isPending;
  const permissionRequests = run.pendingPermissions ?? [];
  const canStop = ['queued', 'running', 'waiting_permission'].includes(run.state);
  const progressText = safeRunText(run.progress, 500);
  const outputText = safeRunText(run.output, 1000);

  return (
    <article className={`task-run-card run-${run.state}`}>
      <div className="task-run-heading">
        <div>
          <strong>Implementation run</strong>
          <span className={`task-status run-status-${run.state}`}>
            <i /> {formatStatus(run.state)}
          </span>
        </div>
        {canStop && (
          <button
            className="button button-secondary button-small"
            disabled={isWorking}
            onClick={() => cancel.mutate()}
          >
            {cancel.isPending ? <LoaderCircle className="spin" size={14} /> : <X size={14} />}
            Stop work
          </button>
        )}
      </div>
      <div className="task-run-meta">
        {run.scopeDirectory && <span>Scheduler scope: {safeRunText(run.scopeDirectory, 500)}</span>}
        {run.broadScope && <span className="run-broad-scope">Entire project scope</span>}
        {run.sessionId && <span>OpenCode session: {safeRunText(run.sessionId, 160)}</span>}
      </div>
      {progressText && (
        <p className="task-run-progress" aria-live="polite">
          <strong>Progress:</strong> {progressText}
        </p>
      )}
      {outputText && (
        <p className="task-run-output">
          <strong>Latest output:</strong> <code>{outputText}</code>
        </p>
      )}
      {run.state === 'cancel_requested' && (
        <p className="task-run-note" role="status">
          Stop requested. Waiting for OpenCode to confirm that the run has stopped.
        </p>
      )}
      {run.state === 'waiting_permission' && permissionRequests.length > 0 && (
        <div className="run-permission-list">
          {permissionRequests.slice(0, 10).map((request) => {
            const title = safeRunText(request.title, 160) || 'OpenCode is requesting permission';
            const kind = safeRunText(request.kind, 80);
            const details = safeRunText(request.details, 1000);
            return (
              <div
                className="run-permission"
                key={request.id}
                role="group"
                aria-label="OpenCode tool permission"
              >
                <div>
                  <strong>{title}</strong>
                  {kind && <span className="run-detail-label">{kind}</span>}
                  {details && (
                    <p>
                      <code>{details}</code>
                    </p>
                  )}
                </div>
                <div className="run-permission-actions">
                  <button
                    className="button button-primary button-small"
                    disabled={isWorking || !request.id}
                    onClick={() =>
                      permission.mutate({ permissionId: request.id, decision: 'allow_once' })
                    }
                  >
                    {permission.isPending && permission.variables?.decision === 'allow_once' ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : null}
                    Allow once
                  </button>
                  <button
                    className="button button-secondary button-small"
                    disabled={isWorking || !request.id}
                    onClick={() =>
                      permission.mutate({ permissionId: request.id, decision: 'reject' })
                    }
                  >
                    {permission.isPending && permission.variables?.decision === 'reject' ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : null}
                    Reject
                  </button>
                </div>
              </div>
            );
          })}
          {permissionRequests.length > 10 && (
            <p className="task-run-note" role="status">
              Showing the first 10 of {permissionRequests.length} pending requests. Resolve these to
              load the next requests.
            </p>
          )}
        </div>
      )}
      {run.state === 'waiting_permission' && permissionRequests.length === 0 && (
        <div className="error-banner" role="alert">
          <AlertCircle size={15} />
          <span>OpenCode is waiting for permission, but no permission details were returned.</span>
        </div>
      )}
      {run.state === 'needs_reconciliation' && (
        <div className="run-reconciliation" role="alert">
          <TriangleAlert size={16} />
          <div>
            <strong>External work needs reconciliation</strong>
            <p>
              Orbyt could not confirm a graceful OpenCode shutdown. Check whether any OpenCode or
              tool process is still working before resolving this run. Orbyt will not retry it
              automatically.
            </p>
            <button
              className="button button-secondary button-small"
              disabled={isWorking}
              onClick={() => setShowReconcile(true)}
            >
              Resolve stopped work…
            </button>
          </div>
        </div>
      )}
      {run.error && <ErrorBanner message={safeRunText(run.error, 2000)} />}
      {(permission.error || cancel.error || reconcile.error) && (
        <ErrorBanner message={errorMessage(permission.error ?? cancel.error ?? reconcile.error)} />
      )}
      {showReconcile && (
        <Modal
          title="Confirm external work has stopped"
          subtitle="Resolve this run only after checking that its OpenCode process is no longer working."
          onClose={() => {
            if (!reconcile.isPending) {
              setShowReconcile(false);
              setConfirmedStopped(false);
            }
          }}
        >
          <div className="form-stack">
            <div className="scope-security-note" role="note">
              <TriangleAlert size={16} />
              <span>
                This records your confirmation and reconciles the run state. It does not stop an
                external process or start another run.
              </span>
            </div>
            {reconcile.error && <ErrorBanner message={errorMessage(reconcile.error)} />}
            <label className="run-confirm-check">
              <input
                type="checkbox"
                checked={confirmedStopped}
                onChange={(event) => setConfirmedStopped(event.target.checked)}
              />
              I have checked that the external work has stopped.
            </label>
            <div className="modal-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={reconcile.isPending}
                onClick={() => {
                  setShowReconcile(false);
                  setConfirmedStopped(false);
                }}
              >
                Keep unresolved
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={!confirmedStopped || reconcile.isPending}
                onClick={() => reconcile.mutate()}
              >
                {reconcile.isPending ? <LoaderCircle className="spin" size={15} /> : null}I stopped
                the external work
              </button>
            </div>
          </div>
        </Modal>
      )}
    </article>
  );
}

function safeRunText(value: unknown, maxLength: number): string {
  const seen = new WeakSet<object>();
  const serialize = (item: unknown, budget: number, depth: number): string => {
    if (budget <= 0) return '';
    if (typeof item === 'string') return item.slice(0, budget);
    if (typeof item === 'number' || typeof item === 'boolean') return String(item).slice(0, budget);
    if (!item || typeof item !== 'object') return '';
    if (seen.has(item)) return '[circular]'.slice(0, budget);
    if (depth >= 2) return '[…]'.slice(0, budget);

    seen.add(item);
    const parts: string[] = [];
    let used = 0;
    const entries: Array<[string, unknown]> = [];
    let hasMore = false;
    if (Array.isArray(item)) {
      item.slice(0, 8).forEach((entry, index) => entries.push([String(index), entry]));
      hasMore = item.length > 8;
    } else {
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        if (entries.length === 8) {
          hasMore = true;
          break;
        }
        entries.push([key, (item as Record<string, unknown>)[key]]);
      }
    }
    for (const [key, entry] of entries) {
      if (used >= budget - 4) break;
      const pairBudget = Math.min(180, budget - used - 4);
      const pair = `${key.slice(0, 50)}: ${serialize(entry, pairBudget - key.length - 2, depth + 1)}`;
      parts.push(pair);
      used += pair.length + 2;
    }
    if (hasMore && used < budget - 5) parts.push('…');
    return `{ ${parts.join(', ')} }`.slice(0, budget);
  };
  const text = serialize(value, maxLength + 1, 0);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function TriageReport({ result, taskStatus }: { result: TriageResult; taskStatus: TaskStatus }) {
  const sections: Array<[string, string[]]> = [
    ['Requirements', result.requirements],
    ['Missing information', result.missingInformation],
    ['Relevant files', result.relevantFiles],
    ['Implementation plan', result.implementationPlan],
    ['Risks', result.risks],
    ['Dependencies', result.dependencies],
  ];
  const actionLabel =
    result.recommendedAction === 'await_approval'
      ? ['queued', 'running', 'awaiting_review'].includes(taskStatus)
        ? 'Implementation started automatically'
        : 'Await manual approval'
      : result.recommendedAction === 'request_context'
        ? 'Request more context'
        : 'Do not proceed';
  return (
    <section
      className="panel"
      aria-label="Triage report"
      style={{ margin: '0 13px 12px', padding: 14 }}
    >
      <div className="panel-heading">
        <div>
          <h2>Triage report</h2>
          <p>
            {formatStatus(result.contextSufficiency)} context · {result.complexity} complexity ·{' '}
            {actionLabel}
          </p>
          <p>
            Suggestions use the Issue and linked GLPI text, public follow-ups, and attachment
            metadata; Orbyt did not inspect project files or send attachment bytes.
          </p>
        </div>
      </div>
      {result.proposedExecutionScope && (
        <p>
          <strong>Proposed scope:</strong> {result.proposedExecutionScope}
        </p>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        {sections.map(([title, items]) =>
          items.length ? (
            <div key={title}>
              <strong>{title}</strong>
              <ul>
                {items.map((item, index) => (
                  <li key={`${title}-${index}`}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null,
        )}
      </div>
    </section>
  );
}

function TaskForm({
  projects,
  onClose,
  task,
}: {
  projects: Project[];
  onClose: () => void;
  task?: Task;
}) {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState(task?.projectId ?? projects[0]?.id ?? '');
  const [scopeId, setScopeId] = useState(task?.scopeId ?? '');
  const [message, setMessage] = useState('');
  const { data: scopeData } = useQuery({
    queryKey: ['scopes', projectId],
    queryFn: () => api.scopes(projectId),
    enabled: Boolean(projectId),
  });
  const scopes = Array.isArray(scopeData) ? scopeData : [];
  const selectedScope = scopes.find((scope) => scope.id === scopeId);
  const save = useMutation({
    mutationFn: (input: {
      projectId: string;
      scopeId: string | null;
      title: string;
      description: string;
      priority: Task['priority'];
    }) => (task ? api.updateTask(task.id, input) : api.createTask(input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
      if (task) {
        queryClient.setQueryData(['task-triage', task.id], null);
        void queryClient.invalidateQueries({ queryKey: ['task-triage', task.id] });
      }
      onClose();
    },
    onError: (error) => setMessage(errorMessage(error)),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save.mutate({
      projectId,
      scopeId: scopeId || null,
      title: String(data.get('title')).trim(),
      description: String(data.get('description')).trim(),
      priority: String(data.get('priority')) as Task['priority'],
    });
  }
  return (
    <Modal
      title={task ? 'Edit task' : 'Create a task'}
      subtitle="Manual tasks are saved locally and start in the pending state. Run triage from a task's actions."
      onClose={onClose}
    >
      <form className="form-stack" onSubmit={submit}>
        <label className="field-label">
          Title
          <input
            name="title"
            required
            maxLength={200}
            defaultValue={task?.title}
            placeholder="What needs to be done?"
          />
        </label>
        <label className="field-label">
          Description
          <textarea
            name="description"
            rows={4}
            maxLength={10000}
            defaultValue={task?.description}
            placeholder="Add requirements, context, or acceptance criteria..."
          />
        </label>
        <label className="field-label">
          Project
          <select
            required
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setScopeId('');
            }}
          >
            {projects.length ? (
              projects.map((project) => (
                <option value={project.id} key={project.id}>
                  {project.name}
                </option>
              ))
            ) : (
              <option value="">Add a project first</option>
            )}
          </select>
        </label>
        <label className="field-label">
          Execution scope <span className="optional">Optional</span>
          <select
            name="scopeId"
            value={scopeId}
            onChange={(event) => setScopeId(event.target.value)}
          >
            <option value="">No scope selected</option>
            {scopes.map((scope) => (
              <option key={scope.id} value={scope.id}>
                {scope.name} · {scope.relativeDirectory}
                {scope.writeAccess ? '' : ' · read-only'}
              </option>
            ))}
          </select>
          {selectedScope && !selectedScope.writeAccess && (
            <span className="field-hint">
              This scope is read-only. Select a write-enabled scope before starting implementation.
            </span>
          )}
        </label>
        <label className="field-label">
          Priority
          <select name="priority" defaultValue={task?.priority ?? 'medium'}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        {message && (
          <div className="form-error">
            <AlertCircle size={15} />
            {message}
          </div>
        )}
        <div className="modal-actions">
          <button className="button button-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={save.isPending || !projects.length}>
            {save.isPending ? (
              <LoaderCircle className="spin" size={15} />
            ) : task ? (
              <Check size={15} />
            ) : (
              <Plus size={15} />
            )}
            {task ? 'Save changes' : 'Create task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Sessions() {
  const { data: projects = [], isLoading: projectsLoading, error: projectsError } = useProjects();
  const {
    data: sessions = [],
    isLoading: sessionsLoading,
    error: sessionsError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: [...keys.sessions, projects.map((project) => project.directory)],
    queryFn: api.openCodeSessions,
    enabled: !projectsLoading && projects.length > 0,
    staleTime: 30_000,
  });

  return (
    <>
      <PageHeading
        eyebrow="AGENT ACTIVITY"
        title="Sessions"
        description="Browse existing OpenCode sessions in your registered projects."
        action={
          <button
            className="button button-secondary"
            onClick={() => void refetch()}
            disabled={projects.length === 0 || isFetching}
          >
            {isFetching ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
            Refresh
          </button>
        }
      />
      {(projectsError || sessionsError) && (
        <ErrorBanner message={errorMessage(projectsError ?? sessionsError)} />
      )}
      <div className="session-notice">
        <span>
          <ShieldCheck size={18} />
        </span>
        <div>
          <strong>Read-only session listing</strong>
          <p>
            Orbyt checks the latest 100 sessions in each registered project folder. It does not
            start, prompt, or schedule sessions from this screen.
          </p>
          <Link className="text-link" to="/settings">
            Check OpenCode connection <ArrowRight size={14} />
          </Link>
        </div>
      </div>
      {projectsLoading || sessionsLoading ? (
        <LoadingState label="Loading OpenCode sessions" />
      ) : projectsError ? null : projects.length === 0 ? (
        <EmptyState
          className="large-empty"
          icon={<FolderKanban size={22} />}
          title="Register a project first"
          description="Orbyt only looks for sessions in project folders that you have added."
          action={
            <Link to="/projects" className="button button-primary">
              View projects <ArrowRight size={15} />
            </Link>
          }
        />
      ) : sessions.length === 0 && !sessionsError ? (
        <EmptyState
          className="large-empty"
          icon={<SquareTerminal size={22} />}
          title="No OpenCode sessions found"
          description="Verify your OpenCode connection or refresh after opening a session in one of these projects."
          action={
            <Link to="/settings" className="button button-secondary">
              Open settings <ArrowRight size={15} />
            </Link>
          }
        />
      ) : sessions.length > 0 ? (
        <section className="panel session-list">
          {sessions.map((session) => (
            <OpenCodeSessionRow session={session} key={session.id} />
          ))}
        </section>
      ) : null}
    </>
  );
}

function OpenCodeSessionRow({ session }: { session: OpenCodeSession }) {
  const updatedDate = new Date(session.updatedAt);
  const hasValidDate = Number.isFinite(session.updatedAt) && !Number.isNaN(updatedDate.getTime());
  const updated = hasValidDate ? updatedDate.toLocaleString() : 'Unknown';
  return (
    <article className="session-row">
      <div className="session-row-icon">
        <SquareTerminal size={17} />
      </div>
      <div className="session-row-main">
        <strong>{session.title.trim() || 'Untitled OpenCode session'}</strong>
        <span>{session.projectName}</span>
      </div>
      <div className="session-row-meta">
        {session.parentId && <span className="session-child-badge">Child session</span>}
        <time dateTime={hasValidDate ? updatedDate.toISOString() : undefined}>{updated}</time>
        <small>{session.id}</small>
      </div>
    </article>
  );
}

function Settings() {
  const queryClient = useQueryClient();
  const { data: settings = {}, isLoading, error } = useAppSettings();
  const [executable, setExecutable] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [verification, setVerification] = useState<{
    connected: boolean;
    message: string;
    version?: string | null;
  } | null>(null);
  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => api.saveSetting(key, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.settings });
      setNotice('Settings saved locally.');
      window.setTimeout(() => setNotice(''), 3000);
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  const verify = useMutation({
    mutationFn: async (input: { executable: string; endpoint: string }) => {
      await Promise.all([
        api.saveSetting('opencode_executable', input.executable),
        api.saveSetting('opencode_endpoint', input.endpoint),
      ]);
      return api.verifyOpenCode();
    },
    onSuccess: (result) => {
      setVerification(result);
      void api.saveSetting('opencode_last_connected', String(result.connected)).then(
        () => queryClient.invalidateQueries({ queryKey: keys.settings }),
        () => undefined,
      );
    },
    onError: (error) => {
      setVerification({ connected: false, message: errorMessage(error) });
      void api.saveSetting('opencode_last_connected', 'false').then(
        () => queryClient.invalidateQueries({ queryKey: keys.settings }),
        () => undefined,
      );
    },
  });
  const saveAll = () => {
    setNotice('');
    void Promise.all([
      api.saveSetting('opencode_executable', executable ?? settings['opencode_executable'] ?? ''),
      api.saveSetting('opencode_endpoint', endpoint ?? settings['opencode_endpoint'] ?? ''),
      api.saveSetting(
        'max_concurrent_sessions',
        settings['max_concurrent_sessions'] ?? String(DEFAULT_MAX_CONCURRENT_SESSIONS),
      ),
      api.saveSetting('approval_policy', 'manual'),
    ])
      .then(() => queryClient.invalidateQueries({ queryKey: keys.settings }))
      .then(() => setNotice('Settings saved locally.'))
      .catch((error) => setNotice(errorMessage(error)));
  };
  return (
    <>
      <PageHeading
        eyebrow="PREFERENCES"
        title="Settings"
        description="Configure how Orbyt connects to your local development tools."
      />
      {error && <ErrorBanner message={errorMessage(error)} />}
      {isLoading ? (
        <LoadingState label="Loading settings" />
      ) : (
        <div className="settings-layout">
          <div className="settings-main">
            <section className="panel settings-section">
              <div className="settings-section-heading">
                <div className="settings-heading-icon purple">
                  <Bot size={18} />
                </div>
                <div>
                  <h2>OpenCode connection</h2>
                  <p>Use your existing installation, configuration, and authentication.</p>
                </div>
              </div>
              <label className="field-label">
                Executable path or command
                <input
                  value={executable ?? settings['opencode_executable'] ?? 'opencode'}
                  onChange={(event) => setExecutable(event.target.value)}
                  placeholder="opencode"
                />
                <span className="field-hint">
                  The connection check invokes only the fixed `api get /api/info` command.
                </span>
              </label>
              <label className="field-label">
                Local service endpoint <span className="optional">Optional</span>
                <input
                  value={endpoint ?? settings['opencode_endpoint'] ?? ''}
                  onChange={(event) => setEndpoint(event.target.value)}
                  placeholder="Auto-detect through OpenCode CLI"
                />
                <span className="field-hint">
                  Connection checks, session listing, and triage use this service when set. Triage
                  sends the task title, description, and linked GLPI text/history to its configured
                  model provider. Leave blank to use OpenCode's service discovery and
                  authentication.
                </span>
              </label>
              {verification && (
                <div
                  className={`connection-result ${verification.connected ? 'connected' : 'disconnected'}`}
                >
                  <span>
                    {verification.connected ? <Check size={15} /> : <AlertCircle size={15} />}
                  </span>
                  <div>
                    <strong>
                      {verification.connected
                        ? `Connected${verification.version ? ` · v${verification.version}` : ''}`
                        : 'Could not connect'}
                    </strong>
                    <p>{verification.message}</p>
                  </div>
                </div>
              )}
              <div className="settings-actions">
                <button
                  className="button button-secondary"
                  onClick={() =>
                    verify.mutate({
                      executable: executable ?? settings['opencode_executable'] ?? '',
                      endpoint: endpoint ?? settings['opencode_endpoint'] ?? '',
                    })
                  }
                  disabled={verify.isPending}
                >
                  {verify.isPending ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Activity size={15} />
                  )}
                  Save and verify connection
                </button>
                <button
                  className="button button-primary"
                  onClick={saveAll}
                  disabled={save.isPending}
                >
                  <Check size={15} />
                  Save settings
                </button>
              </div>
            </section>
            <SourceIntegrations />
            <section className="panel settings-section">
              <div className="settings-section-heading">
                <div className="settings-heading-icon blue">
                  <Gauge size={18} />
                </div>
                <div>
                  <h2>Execution defaults</h2>
                  <p>Initial safety policy for all registered projects.</p>
                </div>
              </div>
              <label className="field-label">
                Default maximum concurrent sessions
                <select
                  value={
                    settings['max_concurrent_sessions'] ?? String(DEFAULT_MAX_CONCURRENT_SESSIONS)
                  }
                  onChange={(event) =>
                    save.mutate({ key: 'max_concurrent_sessions', value: event.target.value })
                  }
                >
                  {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                    <option value={n} key={n}>
                      {n} sessions
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  This is the starting value for new projects. Each project can use a lower limit.
                </span>
              </label>
              <div className="policy-display">
                <div className="policy-icon">
                  <ShieldCheck size={16} />
                </div>
                <div>
                  <strong>Context-gated execution</strong>
                  <span>
                    Local tasks need approval; configured GitHub Projects may auto-start after
                    triage.
                  </span>
                </div>
                <span className="required-badge">Scope-bound</span>
              </div>
            </section>
            <section className="panel settings-section">
              <div className="settings-section-heading">
                <div className="settings-heading-icon amber">
                  <Command size={18} />
                </div>
                <div>
                  <h2>Appearance</h2>
                  <p>Customize your Orbyt workspace.</p>
                </div>
              </div>
              <div className="appearance-row">
                <div>
                  <strong>Color theme</strong>
                  <span>Dark mode is the default. More options coming later.</span>
                </div>
                <div className="theme-choice">
                  <span className="theme-swatch" />
                  Dark <Check size={14} />
                </div>
              </div>
            </section>
          </div>
          <aside className="settings-aside">
            <div className="settings-note">
              <ShieldCheck size={18} />
              <strong>Your credentials stay yours</strong>
              <p>
                Orbyt uses OpenCode's existing login and provider configuration. No model
                credentials are copied into this app.
              </p>
            </div>
            <div className="settings-note subtle-note">
              <CircleHelp size={17} />
              <strong>Local-first storage</strong>
              <p>
                Projects, tasks, and preferences are saved in an SQLite database on this device.
              </p>
            </div>
          </aside>
        </div>
      )}
      {notice && (
        <div className="toast-message">
          <Check size={15} />
          {notice}
          <button aria-label="Dismiss" onClick={() => setNotice('')}>
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );
}

function SourceIntegrations() {
  const queryClient = useQueryClient();
  const { data: projects = [] } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [glpiEndpoint, setGlpiEndpoint] = useState('');
  const [glpiUserToken, setGlpiUserToken] = useState('');
  const [glpiAppToken, setGlpiAppToken] = useState('');
  const [message, setMessage] = useState('');
  const projectId = selectedProjectId || projects[0]?.id || '';
  const {
    data: connections = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['source-connections'],
    queryFn: () => api.sourceConnections(),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['source-connections'] });
    void queryClient.invalidateQueries({ queryKey: keys.tasks });
  };
  const connectGlpi = useMutation({
    mutationFn: () =>
      api.connectGlpi({
        projectId,
        apiEndpoint: glpiEndpoint,
        userToken: glpiUserToken,
        appToken: glpiAppToken,
      }),
    onSuccess: (connection) => {
      setGlpiUserToken('');
      setGlpiAppToken('');
      setMessage(`Connected to GLPI at ${connection.displayName}.`);
      refresh();
    },
    onError: (cause) => setMessage(errorMessage(cause)),
  });
  const disconnect = useMutation({
    mutationFn: api.deleteSourceConnection,
    onSuccess: () => {
      setMessage('Source disconnected. Imported tasks remain in Orbyt.');
      refresh();
    },
    onError: (cause) => setMessage(errorMessage(cause)),
  });

  return (
    <section className="panel settings-section">
      <div className="settings-section-heading">
        <div className="settings-heading-icon blue">
          <GitBranch size={18} />
        </div>
        <div>
          <h2>External task sources</h2>
          <p>Receive assigned GitHub Project issues and load the linked GLPI 10 ticket context.</p>
        </div>
      </div>
      {projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban size={18} />}
          title="Add a project first"
          description="Imported issues and tickets need a local Orbyt project to belong to."
        />
      ) : (
        <>
          <label className="field-label">
            Import into project
            <select
              value={projectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-subsection">
            <GitHubProjectIntegration key={projectId} projectId={projectId} onChanged={refresh} />
          </div>
          <div className="settings-subsection">
            <h3>GLPI 10 instance</h3>
            <label className="field-label">
              REST API base URL
              <input
                value={glpiEndpoint}
                onChange={(event) => setGlpiEndpoint(event.target.value)}
                placeholder="https://glpi.example.com/apirest.php"
                autoComplete="url"
              />
            </label>
            <label className="field-label">
              User API token
              <input
                type="password"
                autoComplete="off"
                value={glpiUserToken}
                onChange={(event) => setGlpiUserToken(event.target.value)}
              />
            </label>
            <label className="field-label">
              App token <span className="optional">Optional</span>
              <input
                type="password"
                autoComplete="off"
                value={glpiAppToken}
                onChange={(event) => setGlpiAppToken(event.target.value)}
              />
              <span className="field-hint">
                Enable the GLPI REST API and use a user token. Credentials are stored in the
                operating system credential store; only the endpoint and connection metadata are
                saved in Orbyt.
              </span>
            </label>
            <button
              className="button button-secondary"
              onClick={() => connectGlpi.mutate()}
              disabled={
                !projectId || !glpiEndpoint.trim() || !glpiUserToken.trim() || connectGlpi.isPending
              }
            >
              {connectGlpi.isPending ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Check size={15} />
              )}
              Connect GLPI
            </button>
          </div>
          {message && (
            <p className="field-hint" role="status">
              {message}
            </p>
          )}
          {error && <ErrorBanner message={errorMessage(error)} />}
          <div className="source-connections">
            <h3>Connected sources</h3>
            {isLoading ? (
              <LoadingState label="Loading source connections" />
            ) : connections.length === 0 ? (
              <p className="empty-copy">No external sources connected yet.</p>
            ) : (
              connections.map((connection) => (
                <div className="source-connection-row" key={connection.id}>
                  <div>
                    <strong>{connection.displayName}</strong>
                    <span>
                      {connection.provider === 'github'
                        ? 'Legacy repository token connection · no longer synced'
                        : 'GLPI 10 lookup for linked tickets'}
                    </span>
                  </div>
                  <div className="source-connection-actions">
                    <button
                      className="icon-button subtle"
                      onClick={() => disconnect.mutate(connection.id)}
                      disabled={disconnect.isPending}
                      aria-label={`Disconnect ${connection.displayName}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}

const AUTO_TRIAGE_PER_SYNC = 3;

async function syncAndTriageGitHubProject(projectId: string) {
  const result = await api.syncGitHubProjectSource(projectId);
  let triaged = 0;
  let triageFailures = 0;
  for (const taskId of result.triageTaskIds.slice(0, AUTO_TRIAGE_PER_SYNC)) {
    try {
      await api.triageTask(taskId);
      triaged += 1;
    } catch {
      triageFailures += 1;
    }
  }
  return { result, triaged, triageFailures };
}

function GitHubProjectSyncScheduler() {
  const queryClient = useQueryClient();
  const { data: sourceData } = useQuery({
    queryKey: ['github-project-sources'],
    queryFn: () => api.githubProjectSources(),
  });
  const sources = Array.isArray(sourceData) ? sourceData : [];
  const running = useRef(false);
  const projectIds = sources.map((source) => source.projectId).join('\u0000');

  useEffect(() => {
    if (!projectIds) return;
    const sourceProjectIds = projectIds.split('\u0000');
    let active = true;
    const syncAll = async () => {
      if (running.current) return;
      running.current = true;
      let changed = false;
      try {
        for (const sourceProjectId of sourceProjectIds) {
          if (!active) break;
          try {
            await syncAndTriageGitHubProject(sourceProjectId);
            changed = true;
          } catch {
            // Settings expose the latest successful sync time; retry on the next interval.
          }
        }
      } finally {
        running.current = false;
        if (active && changed) {
          void queryClient.invalidateQueries({ queryKey: keys.tasks });
          void queryClient.invalidateQueries({ queryKey: ['github-project-sources'] });
        }
      }
    };
    void syncAll();
    const timer = window.setInterval(() => void syncAll(), 5 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [projectIds, queryClient]);

  return null;
}

function normalizeOptionName(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase();
}

function GitHubProjectIntegration({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: settings = {} } = useAppSettings();
  const { data: scopes = [] } = useQuery({
    queryKey: ['scopes', projectId],
    queryFn: () => api.scopes(projectId),
    enabled: Boolean(projectId),
  });
  const [clientIdDraft, setClientIdDraft] = useState<string | null>(null);
  const [organization, setOrganization] = useState('');
  const [projectNumber, setProjectNumber] = useState('');
  const [statusFieldId, setStatusFieldId] = useState('');
  const [pendingOptionId, setPendingOptionId] = useState('');
  const [executionScopeId, setExecutionScopeId] = useState('');
  const [editingConfig, setEditingConfig] = useState(false);
  const [devicePrompt, setDevicePrompt] = useState<DeviceFlowPrompt | null>(null);
  const [message, setMessage] = useState('');
  const clientId = settings.github_app_client_id?.trim() ?? '';
  const clientIdInput = clientIdDraft ?? clientId;
  const sourcesQuery = useQuery({
    queryKey: ['github-project-sources', projectId],
    queryFn: () => api.githubProjectSources(projectId),
    enabled: Boolean(projectId),
  });
  const configuredSource = sourcesQuery.data?.[0];
  const accountQuery = useQuery({
    queryKey: ['github-app-account', clientId],
    queryFn: api.githubAppAccount,
    enabled: Boolean(clientId),
    retry: false,
  });
  const projectsQuery = useQuery({
    queryKey: ['github-organization-projects', clientId, organization],
    queryFn: () => api.githubOrganizationProjects(organization.trim()),
    enabled: Boolean(clientId && accountQuery.data && organization.trim()),
  });
  const numericProjectNumber = Number(projectNumber);
  const fieldsQuery = useQuery({
    queryKey: ['github-project-fields', clientId, organization, numericProjectNumber],
    queryFn: () => api.githubProjectFields(organization.trim(), numericProjectNumber),
    enabled: Boolean(
      clientId && accountQuery.data && organization.trim() && numericProjectNumber > 0,
    ),
  });
  const availableFields = Array.isArray(fieldsQuery.data) ? fieldsQuery.data : [];
  const singleSelectFields = availableFields.filter(
    (field) => field.fieldType === 'ProjectV2SingleSelectField' && field.options.length > 0,
  );
  const defaultStatusField = singleSelectFields.find(
    (field) => normalizeOptionName(field.name) === 'status',
  );
  const effectiveStatusFieldId = singleSelectFields.some((field) => field.id === statusFieldId)
    ? statusFieldId
    : ((defaultStatusField ?? singleSelectFields[0])?.id ?? '');
  const selectedField: GitHubProjectField | undefined = singleSelectFields.find(
    (field) => field.id === effectiveStatusFieldId,
  );
  const defaultPendingOption = selectedField?.options.find(
    (option) => normalizeOptionName(option.name) === 'nao iniciado',
  );
  const effectivePendingOptionId = selectedField?.options.some(
    (option) => option.id === pendingOptionId,
  )
    ? pendingOptionId
    : ((defaultPendingOption ?? selectedField?.options[0])?.id ?? '');
  const selectedScope = scopes.find((scope) => scope.id === executionScopeId && scope.writeAccess);

  useEffect(() => {
    if (!devicePrompt) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await api.githubAppPollDeviceFlow();
        if (!active) return;
        if (result.status === 'pending') {
          timer = window.setTimeout(() => void poll(), Math.max(1, result.data.interval) * 1000);
          return;
        }
        setDevicePrompt(null);
        if (result.status === 'authorized') {
          setMessage(`Connected to GitHub as ${result.data.account.login}.`);
          await queryClient.invalidateQueries({ queryKey: ['github-app-account'] });
          return;
        }
        setMessage(
          result.status === 'denied'
            ? 'GitHub authorization was denied.'
            : 'GitHub device code expired. Start again.',
        );
      } catch (cause) {
        if (active) {
          setDevicePrompt(null);
          setMessage(errorMessage(cause));
        }
      }
    };
    timer = window.setTimeout(() => void poll(), Math.max(1, devicePrompt.interval) * 1000);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [devicePrompt, queryClient]);

  const saveClientId = useMutation({
    mutationFn: async () => {
      const nextClientId = clientIdInput.trim();
      if (clientId && clientId !== nextClientId) await api.githubAppLogout();
      await api.saveSetting('github_app_client_id', nextClientId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.settings });
      setClientIdDraft(null);
      setMessage('GitHub App Client ID saved.');
    },
    onError: (cause) => setMessage(errorMessage(cause)),
  });
  const beginLogin = useMutation({
    mutationFn: api.githubAppBeginDeviceFlow,
    onSuccess: async (prompt) => {
      setDevicePrompt(prompt);
      setMessage('Enter the code on GitHub to finish signing in.');
      try {
        await openUrl('https://github.com/login/device');
      } catch (cause) {
        setMessage(`Open https://github.com/login/device manually. ${errorMessage(cause)}`);
      }
    },
    onError: (cause) => setMessage(errorMessage(cause)),
  });
  const logout = useMutation({
    mutationFn: api.githubAppLogout,
    onSuccess: async () => {
      setDevicePrompt(null);
      await queryClient.invalidateQueries({ queryKey: ['github-app-account'] });
      setMessage('GitHub disconnected.');
    },
    onError: (cause) => setMessage(errorMessage(cause)),
  });
  const saveSource = useMutation({
    mutationFn: () =>
      api.saveGitHubProjectSource({
        projectId,
        organization: organization.trim(),
        projectNumber: numericProjectNumber,
        statusFieldId: effectiveStatusFieldId,
        pendingOptionId: effectivePendingOptionId,
        executionScopeId,
      }),
    onSuccess: async (source) => {
      setEditingConfig(false);
      setMessage(
        `Watching ${source.organization} · ${source.projectTitle} · ${source.pendingOptionName}.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['github-project-sources'] });
      onChanged();
    },
    onError: (cause) => setMessage(errorMessage(cause)),
  });
  const sync = useMutation({
    mutationFn: () => syncAndTriageGitHubProject(projectId),
    onSuccess: async ({ result, triaged, triageFailures }) => {
      setMessage(
        `Synced ${result.seen} matching issues: ${result.imported} new. Triaged ${triaged}${triageFailures ? `; ${triageFailures} triage failed` : ''}.`,
      );
      await queryClient.invalidateQueries({ queryKey: keys.tasks });
      await queryClient.invalidateQueries({ queryKey: ['github-project-sources'] });
      onChanged();
    },
    onError: (cause) => setMessage(errorMessage(cause)),
  });
  const disconnect = useMutation({
    mutationFn: () => api.deleteGitHubProjectSource(projectId),
    onSuccess: async () => {
      setEditingConfig(false);
      setOrganization('');
      setProjectNumber('');
      await queryClient.invalidateQueries({ queryKey: ['github-project-sources'] });
      setMessage('GitHub Project disconnected. Imported tasks remain in Orbyt.');
    },
    onError: (cause) => setMessage(errorMessage(cause)),
  });

  return (
    <>
      <h3>GitHub App and Project</h3>
      <p className="field-hint">
        Create a GitHub App with Device Flow enabled, install it in the organization, and grant read
        access to Issues and Projects.
      </p>
      <label className="field-label">
        GitHub App Client ID
        <div className="form-grid">
          <input
            value={clientIdInput}
            onChange={(event) => setClientIdDraft(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className="button button-secondary"
            onClick={() => saveClientId.mutate()}
            disabled={!clientIdInput.trim() || saveClientId.isPending}
          >
            {saveClientId.isPending ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Check size={15} />
            )}
            Save Client ID
          </button>
        </div>
        <span className="field-hint">
          The Client ID is public. Access tokens stay in the operating system credential store.
        </span>
      </label>
      {accountQuery.isLoading ? (
        <LoadingState label="Checking GitHub login" />
      ) : accountQuery.data ? (
        <div className="source-connection-row">
          <div>
            <strong>Connected as {accountQuery.data.login}</strong>
            <span>GitHub App user session</span>
          </div>
          <button
            className="button button-secondary button-small"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            Disconnect GitHub
          </button>
        </div>
      ) : (
        <button
          className="button button-secondary"
          onClick={() => beginLogin.mutate()}
          disabled={!clientId || beginLogin.isPending}
        >
          {beginLogin.isPending ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <GitBranch size={15} />
          )}
          Sign in with GitHub
        </button>
      )}
      {devicePrompt && (
        <div className="settings-note">
          <strong>Enter this code at github.com/login/device</strong>
          <p className="device-code">{devicePrompt.userCode}</p>
          <span className="field-hint">
            Waiting for authorization · expires in {Math.ceil(devicePrompt.expiresIn / 60)} minutes.
          </span>
          <button
            className="button button-secondary button-small"
            onClick={() => setDevicePrompt(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {accountQuery.error && <ErrorBanner message={errorMessage(accountQuery.error)} />}
      {configuredSource && !editingConfig && (
        <div className="source-connection-row">
          <div>
            <strong>
              {configuredSource.organization} · {configuredSource.projectTitle}
            </strong>
            <span>
              {configuredSource.statusFieldName}: {configuredSource.pendingOptionName} · scope{' '}
              {scopes.find((scope) => scope.id === configuredSource.executionScopeId)
                ?.relativeDirectory ?? 'unavailable'}
              {configuredSource.lastSyncedAt
                ? ` · last sync ${new Date(configuredSource.lastSyncedAt).toLocaleString()}`
                : ' · waiting for first sync'}
            </span>
          </div>
          <div className="source-connection-actions">
            <button
              className="button button-secondary button-small"
              onClick={() => sync.mutate()}
              disabled={!accountQuery.data || sync.isPending}
            >
              {sync.isPending ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <RefreshCw size={14} />
              )}
              Sync now
            </button>
            <button
              className="button button-secondary button-small"
              onClick={() => {
                setOrganization(configuredSource.organization);
                setProjectNumber(String(configuredSource.projectNumber));
                setStatusFieldId(configuredSource.statusFieldId);
                setPendingOptionId(configuredSource.pendingOptionId);
                setExecutionScopeId(configuredSource.executionScopeId ?? '');
                setEditingConfig(true);
              }}
            >
              Edit Project setup
            </button>
            <button
              className="icon-button subtle"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
              aria-label="Disconnect GitHub Project"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      )}
      {accountQuery.data && (!configuredSource || editingConfig) && (
        <>
          <div className="form-grid">
            <label className="field-label">
              Organization login
              <input
                value={organization}
                onChange={(event) => {
                  setOrganization(event.target.value);
                  setProjectNumber('');
                }}
                placeholder="organization"
              />
            </label>
            <label className="field-label">
              Project
              <select
                value={projectNumber}
                onChange={(event) => {
                  setProjectNumber(event.target.value);
                  setStatusFieldId('');
                  setPendingOptionId('');
                }}
                disabled={!organization.trim() || projectsQuery.isLoading}
              >
                <option value="">
                  {projectsQuery.isLoading ? 'Loading Projects…' : 'Choose a Project'}
                </option>
                {(Array.isArray(projectsQuery.data) ? projectsQuery.data : []).map((project) => (
                  <option key={project.id} value={project.number}>
                    {project.title} · #{project.number}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {projectsQuery.error && <ErrorBanner message={errorMessage(projectsQuery.error)} />}
          {numericProjectNumber > 0 && (
            <div className="form-grid">
              <label className="field-label">
                Status field
                <select
                  value={effectiveStatusFieldId}
                  onChange={(event) => {
                    setStatusFieldId(event.target.value);
                    setPendingOptionId('');
                  }}
                  disabled={fieldsQuery.isLoading}
                >
                  <option value="">
                    {fieldsQuery.isLoading ? 'Loading fields…' : 'Choose a single-select field'}
                  </option>
                  {singleSelectFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Status to import
                <select
                  value={effectivePendingOptionId}
                  onChange={(event) => setPendingOptionId(event.target.value)}
                  disabled={!selectedField}
                >
                  <option value="">Choose status</option>
                  {selectedField?.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {fieldsQuery.error && <ErrorBanner message={errorMessage(fieldsQuery.error)} />}
          <label className="field-label">
            Writable execution scope for automatic runs
            <select
              value={executionScopeId}
              onChange={(event) => setExecutionScopeId(event.target.value)}
            >
              <option value="">Choose a scope</option>
              {scopes
                .filter((scope) => scope.writeAccess)
                .map((scope) => (
                  <option key={scope.id} value={scope.id}>
                    {scope.name} · {scope.relativeDirectory || '.'}
                  </option>
                ))}
            </select>
            {scopes.filter((scope) => scope.writeAccess).length === 0 && (
              <span className="field-hint">
                Create a writable scope in this project's settings before connecting GitHub.
              </span>
            )}
          </label>
          <span className="field-hint">
            Only Issues assigned to your GitHub account, in this Project, with this Status are
            synchronized. New Issues are triaged automatically; sufficient context starts ACP in the
            selected scope. Context requests wait for your review.
          </span>
          <div className="source-connection-actions">
            <button
              className="button button-secondary"
              onClick={() => saveSource.mutate()}
              disabled={
                !projectId ||
                !accountQuery.data ||
                !organization.trim() ||
                numericProjectNumber <= 0 ||
                !effectiveStatusFieldId ||
                !effectivePendingOptionId ||
                !selectedScope ||
                saveSource.isPending
              }
            >
              {saveSource.isPending ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Check size={15} />
              )}
              {configuredSource ? 'Update Project' : 'Connect Project'}
            </button>
            {configuredSource && (
              <button
                className="button button-secondary"
                onClick={() => sync.mutate()}
                disabled={sync.isPending}
              >
                {sync.isPending ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <RefreshCw size={15} />
                )}
                Sync now
              </button>
            )}
            {configuredSource && (
              <button
                className="button button-secondary"
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
              >
                <Trash2 size={15} />
                Disconnect Project
              </button>
            )}
          </div>
          {configuredSource?.lastSyncedAt && (
            <p className="field-hint">
              Last successful sync: {new Date(configuredSource.lastSyncedAt).toLocaleString()}
            </p>
          )}
        </>
      )}
      {message && (
        <p className="field-hint" role="status">
          {message}
        </p>
      )}
    </>
  );
}

function TaskTable({ tasks, projects }: { tasks: Task[]; projects: Project[] }) {
  return (
    <div className="compact-task-list">
      {tasks.map((task) => (
        <div className="compact-task-row" key={task.id}>
          <span className={`compact-priority priority-${task.priority}`} />
          <div className="compact-task-copy">
            <strong>{task.title}</strong>
            <span>{projects.find((p) => p.id === task.projectId)?.name ?? 'Unknown project'}</span>
          </div>
          <span className={`task-status status-${task.status}`}>
            <i />
            {formatStatus(task.status)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-heading">
          <div>
            <h2 id="modal-title">{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty-state ${className}`}>
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="loading-state">
      <LoaderCircle className="spin" size={18} />
      {label}…
    </div>
  );
}
function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="error-banner">
      <AlertCircle size={16} />
      <span>{message}</span>
    </div>
  );
}
function formatStatus(status: string) {
  return status.replaceAll('_', ' ');
}

export default App;
