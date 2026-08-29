import * as vscode from 'vscode';

export type SendFormat = 'hex' | 'ascii';

export interface SendTemplate {
  id: string;
  name: string;
  format: SendFormat;
  data: string;
}

const STORAGE_KEY = 'sendTemplates';

/** CRUD over `serialPort.sendTemplates` configuration, shared across all workspaces via User
 * scope like the other Default Settings — see `contributes.configuration` in package.json. */
export class TemplateStore {
  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('serialPort');
  }

  list(): SendTemplate[] {
    return this.config().get<SendTemplate[]>(STORAGE_KEY, []);
  }

  get(id: string): SendTemplate | undefined {
    return this.list().find((template) => template.id === id);
  }

  async add(template: Omit<SendTemplate, 'id'>): Promise<SendTemplate> {
    const full: SendTemplate = { ...template, id: generateId() };
    await this.config().update(STORAGE_KEY, [...this.list(), full], vscode.ConfigurationTarget.Global);
    return full;
  }

  async update(id: string, patch: Partial<Omit<SendTemplate, 'id'>>): Promise<void> {
    const templates = this.list().map((template) => (template.id === id ? { ...template, ...patch } : template));
    await this.config().update(STORAGE_KEY, templates, vscode.ConfigurationTarget.Global);
  }

  async remove(id: string): Promise<void> {
    await this.config().update(
      STORAGE_KEY,
      this.list().filter((template) => template.id !== id),
      vscode.ConfigurationTarget.Global,
    );
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
