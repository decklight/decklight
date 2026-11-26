// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';

// The helper owns the assertion. Its stdin closes even if Decklight is killed.
// macOS also watches Decklight's PID directly.
const windows = `
Add-Type -Namespace Decklight -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint flags);
'@
if (![Decklight.Power]::SetThreadExecutionState(2147483649)) { exit 1 }
try {
  [Console]::WriteLine('ready')
  [void][Console]::In.ReadToEnd()
} finally {
  [void][Decklight.Power]::SetThreadExecutionState(2147483648)
}
`;

export async function keepAwake({ platform = process.platform, launch = spawn } = {}) {
  const commands = {
    darwin: ['caffeinate', ['-i', '-w', String(process.pid)]],
    linux: ['systemd-inhibit', ['--what=idle:sleep', '--mode=block', '--who=Decklight',
      '--why=Exporting a deck', process.execPath, '-e',
      'console.log("ready"); process.stdin.resume()']],
    win32: ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windows]],
  };
  const command = commands[platform];
  if (!command) return { active: false, release: async () => {} };
  const [bin, args] = command;
  const child = launch(bin, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  child.stdin.on('error', () => {});
  const closed = new Promise((resolve) => child.once('close', resolve));
  const active = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.stdin.end();
      child.kill();
      finish(false);
    }, 5000);
    function finish(ready) {
      clearTimeout(timer);
      resolve(ready);
    }
    child.once('error', () => finish(false));
    child.once('close', () => finish(false));
    if (platform === 'darwin') child.once('spawn', () => finish(true));
    else {
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('ready')) finish(true);
      });
    }
  });
  return {
    active,
    async release() {
      child.stdin.end();
      if (platform === 'darwin') child.kill();
      await closed;
    },
  };
}
