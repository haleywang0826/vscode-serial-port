import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  test('extension activates without throwing', async () => {
    const ext = vscode.extensions.getExtension('REPLACE_ME_PUBLISHER_ID.vscode-serial-port');
    assert.ok(ext, 'extension should be discoverable by id');

    await ext?.activate();

    assert.strictEqual(ext?.isActive, true);
  });
});
