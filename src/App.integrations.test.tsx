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
});
