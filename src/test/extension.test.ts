import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  test('extension activates and registers the placeholder command', async () => {
    const ext = vscode.extensions.getExtension('REPLACE_ME_PUBLISHER_ID.vscode-serial-port');
    assert.ok(ext, 'extension should be discoverable by id');

    await ext?.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('serialPort.helloWorld'));
  });
});
