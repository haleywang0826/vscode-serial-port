import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('serialPort.helloWorld', () => {
    vscode.window.showInformationMessage('Serial Port extension is active.');
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {}
