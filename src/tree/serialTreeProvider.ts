import * as vscode from 'vscode';
import { ConnectionManager, DEFAULT_PORT_CONFIG, PortConfig } from '../serial/connectionManager';
import { TemplateStore } from '../templates/templateStore';
import { CHECKBOX_LABELS, CONTEXT, SETTING_FIELD_LABELS, SerialTreeItem, SettingField } from './treeItems';

const REFRESH_DEBOUNCE_MS = 150;

/** Backs the "Serial Port" activity bar view: port picker, default settings, open sessions, templates. */
export class SerialTreeProvider implements vscode.TreeDataProvider<SerialTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SerialTreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  selectedPort: string | undefined;
  defaultConfig: PortConfig = { ...DEFAULT_PORT_CONFIG };

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly templates: TemplateStore,
  ) {
    connections.onDidChange(() => this.scheduleRefresh());
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  /** Coalesces bursts of connection updates (bytes in/out on a busy port) into one tree refresh. */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  getTreeItem(element: SerialTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SerialTreeItem): SerialTreeItem[] {
    if (!element) {
      return this.getRootItems();
    }
    switch (element.node.kind) {
      case 'defaultSettingsRoot':
        return this.getSettingRows(this.defaultConfig, false);
      case 'session':
        return this.getSessionRows(element.node.portPath!);
      case 'templatesRoot':
        return this.getTemplateRows();
      default:
        return [];
    }
  }

  private getRootItems(): SerialTreeItem[] {
    const items = [this.getPortPickerItem(), this.getDefaultSettingsRootItem()];
    for (const connection of this.connections.list()) {
      items.push(this.getSessionItem(connection.path));
    }
    items.push(this.getTemplatesRootItem());
    return items;
  }

  private getPortPickerItem(): SerialTreeItem {
    const label = this.selectedPort ? `Port: ${this.selectedPort}` : 'Select a port…';
    const item = new SerialTreeItem(label, vscode.TreeItemCollapsibleState.None, { kind: 'portPicker' });
    item.command = { command: 'serialPort.selectPort', title: 'Select Port' };
    const alreadyOpen = this.selectedPort !== undefined && this.connections.isOpen(this.selectedPort);
    item.contextValue = alreadyOpen ? CONTEXT.portPickerOpen : CONTEXT.portPicker;
    item.iconPath = new vscode.ThemeIcon('plug');
    if (alreadyOpen) {
      item.description = 'opened';
    }
    return item;
  }

  private getDefaultSettingsRootItem(): SerialTreeItem {
    const item = new SerialTreeItem('Default Port Settings', vscode.TreeItemCollapsibleState.Collapsed, {
      kind: 'defaultSettingsRoot',
    });
    item.contextValue = CONTEXT.defaultSettingsRoot;
    return item;
  }

  private getSettingRows(config: PortConfig, locked: boolean): SerialTreeItem[] {
    return (Object.keys(SETTING_FIELD_LABELS) as SettingField[]).map((field) => {
      const item = new SerialTreeItem(
        `${SETTING_FIELD_LABELS[field]}: ${config[field]}`,
        vscode.TreeItemCollapsibleState.None,
        { kind: locked ? 'sessionConfigRow' : 'defaultSettingRow', field },
      );
      const canEditLive = !locked || field === 'baudRate';
      if (canEditLive) {
        item.command = {
          command: locked ? 'serialPort.editSessionSetting' : 'serialPort.editDefaultSetting',
          title: 'Edit',
          arguments: [item],
        };
        item.contextValue = locked ? CONTEXT.sessionConfigRowLive : CONTEXT.defaultSettingRow;
      } else {
        item.description = 'reopen to change';
        item.contextValue = CONTEXT.sessionConfigRowLocked;
      }
      return item;
    });
  }

  private getSessionItem(portPath: string): SerialTreeItem {
    const item = new SerialTreeItem(portPath, vscode.TreeItemCollapsibleState.Expanded, {
      kind: 'session',
      portPath,
    });
    item.contextValue = CONTEXT.session;
    item.iconPath = new vscode.ThemeIcon('debug-disconnect');
    return item;
  }

  private getSessionRows(portPath: string): SerialTreeItem[] {
    const connection = this.connections.get(portPath);
    if (!connection) {
      return [];
    }
    const configRows = this.getSettingRows(connection.config, true);
    for (const row of configRows) {
      row.node.portPath = portPath;
    }

    const checkboxRows = (['hexSend', 'hexRecv', 'record'] as const).map((checkbox) => {
      const checked =
        checkbox === 'hexSend' ? connection.hexSend : checkbox === 'hexRecv' ? connection.hexRecv : connection.recording;
      const item = new SerialTreeItem(CHECKBOX_LABELS[checkbox], vscode.TreeItemCollapsibleState.None, {
        kind: 'sessionCheckboxRow',
        checkbox,
        portPath,
      });
      item.contextValue = CONTEXT.sessionCheckboxRow;
      item.checkboxState = checked
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      return item;
    });

    const statsItem = new SerialTreeItem(
      `Sent: ${connection.stats.bytesSent} B · Received: ${connection.stats.bytesReceived} B`,
      vscode.TreeItemCollapsibleState.None,
      { kind: 'sessionStatsRow', portPath },
    );
    statsItem.contextValue = CONTEXT.sessionStatsRow;
    statsItem.iconPath = new vscode.ThemeIcon('graph-line');

    return [...configRows, ...checkboxRows, statsItem];
  }

  private getTemplatesRootItem(): SerialTreeItem {
    const item = new SerialTreeItem('Send Templates', vscode.TreeItemCollapsibleState.Collapsed, {
      kind: 'templatesRoot',
    });
    item.contextValue = CONTEXT.templatesRoot;
    return item;
  }

  private getTemplateRows(): SerialTreeItem[] {
    return this.templates.list().map((template) => {
      const preview = template.data.length > 24 ? `${template.data.slice(0, 24)}…` : template.data;
      const item = new SerialTreeItem(template.name, vscode.TreeItemCollapsibleState.None, {
        kind: 'templateRow',
        templateId: template.id,
      });
      item.description = `[${template.format}] ${preview}`;
      item.contextValue = CONTEXT.templateRow;
      item.command = { command: 'serialPort.editTemplate', title: 'Edit Template', arguments: [item] };
      return item;
    });
  }
}
