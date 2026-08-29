import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { ConnectionManager, PortConfig } from './serial/connectionManager';
import { asciiStringToBytes, hexStringToBytes } from './serial/format';
import { createSerialTerminal, SerialTerminal } from './serial/pseudoterminal';
import { SendFormat, TemplateStore } from './templates/templateStore';
import { SerialTreeProvider } from './tree/serialTreeProvider';
import { SerialTreeItem, SettingField } from './tree/treeItems';

const BAUD_RATE_PRESETS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 250000];
const DATA_BITS_OPTIONS = [5, 6, 7, 8] as const;
const STOP_BITS_OPTIONS = [1, 1.5, 2] as const;
const PARITY_OPTIONS = ['none', 'even', 'odd', 'mark', 'space'] as const;
const CUSTOM_BAUD_RATE_LABEL = 'Custom…';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager();
  const templates = new TemplateStore(context.globalState);
  const treeProvider = new SerialTreeProvider(connections, templates);
  const terminals = new Map<string, SerialTerminal>();

  const treeView = vscode.window.createTreeView('serialPortExplorer', {
    treeDataProvider: treeProvider,
  });

  treeView.onDidChangeCheckboxState((event) => {
    for (const [item, state] of event.items) {
      if (item.node.kind !== 'sessionCheckboxRow' || !item.node.portPath || !item.node.checkbox) {
        continue;
      }
      const connection = connections.get(item.node.portPath);
      if (!connection) {
        continue;
      }
      const checked = state === vscode.TreeItemCheckboxState.Checked;
      switch (item.node.checkbox) {
        case 'hexSend':
          connection.setHexSend(checked);
          break;
        case 'hexRecv':
          connection.setHexRecv(checked);
          break;
        case 'record':
          connection.setRecording(checked);
          break;
      }
    }
  });

  // Tears down the terminal for any session that closed without going through
  // serialPort.closeSession (e.g. the device was physically unplugged).
  connections.onDidChange(() => {
    for (const [path, terminal] of terminals) {
      if (!connections.isOpen(path)) {
        terminal.dispose();
        terminals.delete(path);
      }
    }
  });

  context.subscriptions.push(
    treeView,
    connections,
    { dispose: () => terminals.forEach((terminal) => terminal.dispose()) },
    vscode.commands.registerCommand('serialPort.selectPort', () => selectPort(treeProvider)),
    vscode.commands.registerCommand('serialPort.openSelectedPort', () =>
      openSelectedPort(treeProvider, connections, terminals),
    ),
    vscode.commands.registerCommand('serialPort.alreadyOpenNoop', () => {
      /* the port picker's inline button while the selected port is already open */
    }),
    vscode.commands.registerCommand('serialPort.closeSession', (item?: SerialTreeItem) => {
      const path = item?.node.portPath;
      return path ? connections.close(path) : undefined;
    }),
    vscode.commands.registerCommand('serialPort.editDefaultSetting', (item?: SerialTreeItem) =>
      item ? editDefaultSetting(item, treeProvider) : undefined,
    ),
    vscode.commands.registerCommand('serialPort.editSessionSetting', (item?: SerialTreeItem) =>
      item ? editSessionSetting(item, connections) : undefined,
    ),
    vscode.commands.registerCommand('serialPort.addTemplate', () => addTemplate(templates, treeProvider)),
    vscode.commands.registerCommand('serialPort.editTemplate', (item?: SerialTreeItem) =>
      item ? editTemplate(item, templates, treeProvider) : undefined,
    ),
    vscode.commands.registerCommand('serialPort.sendTemplate', (item?: SerialTreeItem) =>
      item ? sendTemplate(item, templates, connections) : undefined,
    ),
  );
}

export function deactivate(): void {}

async function selectPort(treeProvider: SerialTreeProvider): Promise<void> {
  const ports = await SerialPort.list();
  if (ports.length === 0) {
    vscode.window.showInformationMessage('No serial ports found.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    ports.map((port) => ({ label: port.path, description: port.manufacturer ?? port.pnpId ?? '' })),
    { placeHolder: 'Select a serial port' },
  );
  if (!picked) {
    return;
  }
  treeProvider.selectedPort = picked.label;
  treeProvider.refresh();
}

async function openSelectedPort(
  treeProvider: SerialTreeProvider,
  connections: ConnectionManager,
  terminals: Map<string, SerialTerminal>,
): Promise<void> {
  const path = treeProvider.selectedPort;
  if (!path) {
    vscode.window.showInformationMessage('Select a port first.');
    return;
  }
  if (connections.isOpen(path)) {
    vscode.window.showInformationMessage(`${path} is already open.`);
    return;
  }
  try {
    const connection = await connections.open(path, treeProvider.defaultConfig);
    const terminal = createSerialTerminal(connection);
    terminals.set(path, terminal);
    terminal.terminal.show(false);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to open ${path}: ${errorMessage(err)}`);
  }
}

async function editDefaultSetting(item: SerialTreeItem, treeProvider: SerialTreeProvider): Promise<void> {
  const field = item.node.field;
  if (!field) {
    return;
  }
  const updated = await promptForSetting(field, treeProvider.defaultConfig);
  if (updated) {
    treeProvider.defaultConfig = updated;
    treeProvider.refresh();
  }
}

async function editSessionSetting(item: SerialTreeItem, connections: ConnectionManager): Promise<void> {
  const path = item.node.portPath;
  if (!path || item.node.field !== 'baudRate') {
    return; // only baud rate is ever wired to a live-editable command
  }
  const connection = connections.get(path);
  if (!connection) {
    return;
  }
  const baudRate = await pickBaudRate(connection.config.baudRate);
  if (baudRate === undefined) {
    return;
  }
  try {
    await connection.updateBaudRate(baudRate);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to change baud rate: ${errorMessage(err)}`);
  }
}

async function promptForSetting(field: SettingField, config: PortConfig): Promise<PortConfig | undefined> {
  switch (field) {
    case 'baudRate': {
      const baudRate = await pickBaudRate(config.baudRate);
      return baudRate === undefined ? undefined : { ...config, baudRate };
    }
    case 'dataBits': {
      const picked = await vscode.window.showQuickPick(DATA_BITS_OPTIONS.map(String), { placeHolder: 'Data bits' });
      return picked ? { ...config, dataBits: Number(picked) as PortConfig['dataBits'] } : undefined;
    }
    case 'parity': {
      const picked = await vscode.window.showQuickPick([...PARITY_OPTIONS], { placeHolder: 'Parity' });
      return picked ? { ...config, parity: picked as PortConfig['parity'] } : undefined;
    }
    case 'stopBits': {
      const picked = await vscode.window.showQuickPick(STOP_BITS_OPTIONS.map(String), { placeHolder: 'Stop bits' });
      return picked ? { ...config, stopBits: Number(picked) as PortConfig['stopBits'] } : undefined;
    }
  }
}

async function pickBaudRate(current: number): Promise<number | undefined> {
  const items: vscode.QuickPickItem[] = [
    ...BAUD_RATE_PRESETS.map((rate) => ({ label: String(rate), description: rate === current ? 'current' : undefined })),
    { label: CUSTOM_BAUD_RATE_LABEL },
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Baud rate' });
  if (!picked) {
    return undefined;
  }
  if (picked.label !== CUSTOM_BAUD_RATE_LABEL) {
    return Number(picked.label);
  }
  const input = await vscode.window.showInputBox({
    prompt: 'Custom baud rate',
    value: String(current),
    validateInput: (value) => (/^\d+$/.test(value) ? undefined : 'Enter a positive integer'),
  });
  return input ? Number(input) : undefined;
}

async function addTemplate(templates: TemplateStore, treeProvider: SerialTreeProvider): Promise<void> {
  const name = await vscode.window.showInputBox({ prompt: 'Template name' });
  if (!name) {
    return;
  }
  const format = await pickFormat();
  if (!format) {
    return;
  }
  const data = await promptPayload(format);
  if (data === undefined) {
    return;
  }
  await templates.add({ name, format, data });
  treeProvider.refresh();
}

async function editTemplate(
  item: SerialTreeItem,
  templates: TemplateStore,
  treeProvider: SerialTreeProvider,
): Promise<void> {
  const templateId = item.node.templateId;
  const template = templateId ? templates.get(templateId) : undefined;
  if (!templateId || !template) {
    return;
  }
  const action = await vscode.window.showQuickPick(['Rename', 'Edit Payload', 'Delete'], {
    placeHolder: template.name,
  });
  if (!action) {
    return;
  }
  if (action === 'Delete') {
    await templates.remove(templateId);
  } else if (action === 'Rename') {
    const name = await vscode.window.showInputBox({ prompt: 'Template name', value: template.name });
    if (name) {
      await templates.update(templateId, { name });
    }
  } else {
    const format = await pickFormat(template.format);
    if (!format) {
      return;
    }
    const data = await promptPayload(format, template.data);
    if (data === undefined) {
      return;
    }
    await templates.update(templateId, { format, data });
  }
  treeProvider.refresh();
}

async function sendTemplate(
  item: SerialTreeItem,
  templates: TemplateStore,
  connections: ConnectionManager,
): Promise<void> {
  const templateId = item.node.templateId;
  const template = templateId ? templates.get(templateId) : undefined;
  if (!template) {
    return;
  }
  const open = connections.list();
  if (open.length === 0) {
    vscode.window.showWarningMessage('No ports are open.');
    return;
  }
  let targetPath: string;
  if (open.length === 1) {
    targetPath = open[0].path;
  } else {
    const picked = await vscode.window.showQuickPick(
      open.map((connection) => connection.path),
      { placeHolder: 'Send to which port?' },
    );
    if (!picked) {
      return;
    }
    targetPath = picked;
  }
  const connection = connections.get(targetPath);
  if (!connection) {
    return;
  }
  try {
    const bytes = template.format === 'hex' ? hexStringToBytes(template.data) : asciiStringToBytes(template.data);
    await connection.write(bytes);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to send template: ${errorMessage(err)}`);
  }
}

async function pickFormat(current?: SendFormat): Promise<SendFormat | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Hex', value: 'hex' as const },
      { label: 'ASCII', value: 'ascii' as const },
    ],
    { placeHolder: current ? `Format (current: ${current})` : 'Format' },
  );
  return picked?.value;
}

async function promptPayload(format: SendFormat, value?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: format === 'hex' ? 'Payload (space-separated hex bytes, e.g. "0A FF 3C")' : 'Payload (raw text)',
    value,
    validateInput: (input) => {
      if (format !== 'hex') {
        return undefined;
      }
      try {
        hexStringToBytes(input);
        return undefined;
      } catch (err) {
        return errorMessage(err);
      }
    },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
