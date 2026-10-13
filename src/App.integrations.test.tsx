import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('external source connections', () => {
  beforeEach(() => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_projects')
        return Promise.resolve([
          {
            id: 'project-1',
            name: 'Orbyt',
            description: '',
            directory: '/tmp/orbyt',
            maxConcurrentSessions: 2,
            approvalPolicy: 'manual',
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]);
      if (command === 'list_tasks' || command === 'list_source_connections')
        return Promise.resolve([]);
      if (command === 'list_scopes' || command === 'list_github_project_sources')
        return Promise.resolve([]);
      if (command === 'get_settings') return Promise.resolve({});
      if (command === 'connect_glpi')
        return Promise.resolve({
          id: 'connection-1',
          provider: 'glpi',
          projectId: 'project-1',
          sourceKey: 'https://support.example.org/apirest.php/',
          displayName: 'https://support.example.org',
          apiEndpoint: 'https://support.example.org/apirest.php/',
          lastSyncedAt: null,
          createdAt: 'now',
          updatedAt: 'now',
        });
      return Promise.resolve({});
    });
  });

  it('sends GLPI tokens only through the native connection command', async () => {
    renderSettings();

    fireEvent.change(await screen.findByLabelText('REST API base URL'), {
      target: { value: 'https://support.example.org/apirest.php' },
    });
    fireEvent.change(screen.getByLabelText('User API token'), {
      target: { value: 'glpi-user-token' },
    });
    fireEvent.change(screen.getByLabelText(/App token/), {
      target: { value: 'glpi-app-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect GLPI' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('connect_glpi', {
        input: {
          projectId: 'project-1',
          apiEndpoint: 'https://support.example.org/apirest.php',
          userToken: 'glpi-user-token',
          appToken: 'glpi-app-token',
        },
      });
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      'save_setting',
      expect.objectContaining({ value: 'glpi-user-token' }),
    );
    expect(await screen.findByText(/Connected to GLPI at/)).toBeInTheDocument();
  });

  it('renders descriptive GLPI connection failures as errors', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_projects')
        return Promise.resolve([
          {
            id: 'project-1',
            name: 'Orbyt',
            description: '',
            directory: '/tmp/orbyt',
            maxConcurrentSessions: 2,
            approvalPolicy: 'manual',
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]);
      if (command === 'list_tasks' || command === 'list_source_connections')
        return Promise.resolve([]);
      if (command === 'list_scopes' || command === 'list_github_project_sources')
        return Promise.resolve([]);
      if (command === 'get_settings') return Promise.resolve({});
      if (command === 'connect_glpi')
        return Promise.reject('GLPI returned 404: check the REST API base URL.');
      return Promise.resolve({});
    });
    renderSettings();

    fireEvent.change(await screen.findByLabelText('REST API base URL'), {
      target: { value: 'https://support.example.org/apirest.php' },
    });
    fireEvent.change(screen.getByLabelText('User API token'), {
      target: { value: 'glpi-user-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect GLPI' }));

    expect(
      await screen.findByText('GLPI returned 404: check the REST API base URL.'),
    ).toBeInTheDocument();
  });

  it('retires GitHub intake setup UI while retaining GLPI source settings', async () => {
    renderSettings();

    expect(await screen.findByRole('heading', { name: 'GLPI ticket source' })).toBeInTheDocument();
    expect(screen.queryByText(/GitHub App and Project/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sign in with GitHub/i)).not.toBeInTheDocument();
  });

  it('defaults GLPI auto-triage off and explains what triage sends', async () => {
    renderSettings();

    const optIn = await screen.findByRole('checkbox', {
      name: /Automatically triage newly imported GLPI tasks/i,
    });
    expect(optIn).not.toBeChecked();
    expect(
      screen.getByText(/ticket text, public follow-ups, and attachment metadata are sent/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Attachment bytes are never sent/i)).toBeInTheDocument();
    expect(
      screen.getByText(/does not automatically start implementation or an ACP session/i),
    ).toBeInTheDocument();
  });

  it('saves the GLPI auto-triage opt-in explicitly', async () => {
    renderSettings();
    const optIn = await screen.findByRole('checkbox', {
      name: /Automatically triage newly imported GLPI tasks/i,
    });
    fireEvent.click(optIn);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('save_setting', {
        key: 'glpi_auto_triage',
        value: 'true',
      }),
    );
  });

  it('syncs connected GLPI sources and triages only the returned new IDs when opted in', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_projects')
        return Promise.resolve([
          {
            id: 'project-1',
            name: 'Orbyt',
            description: '',
            directory: '/tmp/orbyt',
            maxConcurrentSessions: 2,
            approvalPolicy: 'manual',
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]);
      if (command === 'list_tasks') return Promise.resolve([]);
      if (command === 'list_source_connections')
        return Promise.resolve([
          {
            id: 'glpi-1',
            provider: 'glpi',
            projectId: 'project-1',
            displayName: 'GLPI',
            sourceKey: 'https://glpi.example',
            apiEndpoint: 'https://glpi.example/apirest.php',
            lastSyncedAt: null,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]);
      if (command === 'get_settings') return Promise.resolve({ glpi_auto_triage: 'true' });
      if (command === 'sync_source_connection')
        return Promise.resolve({
          connectionId: 'glpi-1',
          provider: 'glpi',
          seen: 2,
          imported: 1,
          refreshed: 1,
          unchanged: 0,
          truncated: false,
          limit: 100,
          syncedAt: 'now',
          triageTaskIds: ['new-task'],
        });
      if (command === 'triage_task') return Promise.resolve({});
      return Promise.resolve([]);
    });
    renderSettings();

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('sync_source_connection', { connectionId: 'glpi-1' }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('triage_task', { taskId: 'new-task' }),
    );
  });
});
