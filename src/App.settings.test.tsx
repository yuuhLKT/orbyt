import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(() => Promise.resolve(true)),
  requestPermission: vi.fn(() => Promise.resolve('granted')),
  sendNotification: vi.fn(),
}));

const project = {
  id: 'local-1',
  name: 'Orbyt',
  description: '',
  directory: '/work/orbyt',
  maxConcurrentSessions: 2,
  approvalPolicy: 'manual' as const,
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z',
};

describe('GitHub Project and GLPI settings', () => {
  beforeEach(() => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_projects') return Promise.resolve([project]);
      if (command === 'list_tasks') return Promise.resolve([]);
      if (command === 'get_settings') return Promise.resolve({ github_app_client_id: 'client-1' });
      if (command === 'list_scopes')
        return Promise.resolve([
          {
            id: 'scope-1',
            projectId: project.id,
            name: 'Plugin source',
            relativeDirectory: 'plugins/insights',
            readAccess: true,
            writeAccess: true,
            conflictPolicy: 'serialize',
          },
        ]);
      if (command === 'list_source_connections') return Promise.resolve([]);
      if (command === 'list_github_project_sources') return Promise.resolve([]);
      if (command === 'github_app_account') return Promise.resolve({ id: 7, login: 'yuuhLKT' });
      if (command === 'list_github_organization_projects')
        return Promise.resolve([
          {
            id: 'project-node-1',
            number: 12,
            title: 'Unita Soluções',
            url: 'https://github.com/orgs/acme/projects/12',
          },
        ]);
      if (command === 'list_github_project_fields')
        return Promise.resolve([
          {
            id: 'status-field',
            name: 'Status',
            fieldType: 'ProjectV2SingleSelectField',
            options: [
              { id: 'not-started', name: 'Não Iniciado' },
              { id: 'done', name: 'Concluído' },
            ],
          },
        ]);
      return Promise.resolve({});
    });
  });

  it('discovers Status options and saves the selected writable scope', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByLabelText('Organization login'), {
      target: { value: 'acme' },
    });
    await screen.findByRole('option', { name: /Unita Soluções/ });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '12' } });
    await waitFor(() => expect(screen.getByLabelText('Status field')).toHaveValue('status-field'));
    await waitFor(() =>
      expect(screen.getByLabelText('Status to import')).toHaveValue('not-started'),
    );
    fireEvent.change(screen.getByLabelText('Writable execution scope for automatic runs'), {
      target: { value: 'scope-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Project' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('save_github_project_source', {
        input: {
          projectId: project.id,
          organization: 'acme',
          projectNumber: 12,
          statusFieldId: 'status-field',
          pendingOptionId: 'not-started',
          executionScopeId: 'scope-1',
        },
      });
    });
  });
});
