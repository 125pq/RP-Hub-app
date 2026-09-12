import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const source = await readFile(new URL('../android/build-and-install.ps1', import.meta.url), 'utf8');
const start = source.indexOf('function Invoke-Native(');
const end = source.indexOf('\n# ----', start);
assert.ok(start >= 0 && end > start);
assert.match(source, /\$build = Invoke-Native -StreamOutput/);
const helper = source.slice(start, end);
const root = await mkdtemp(path.join(os.tmpdir(), 'rphub-live-build-'));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
try {
  const gate = path.join(root, 'continue');
  const child = path.join(root, 'child.ps1');
  const harness = path.join(root, 'harness.ps1');
  await writeFile(child, `Write-Output 'BUILD_STARTED'
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (-not (Test-Path -LiteralPath ${quote(gate)})) {
  if ([DateTime]::UtcNow -gt $deadline) { exit 91 }
  Start-Sleep -Milliseconds 50
}
[Console]::Error.WriteLine('BUILD_WARNING')
Write-Output 'APK=C:\\test path\\result.apk'
exit 37
`);
  await writeFile(harness, `$ErrorActionPreference = 'Stop'
${helper}
$result = Invoke-Native -StreamOutput { & ${process.platform === 'win32' ? 'powershell.exe' : 'pwsh'} -NoProfile -File ${quote(child)} }
if ($result.ExitCode -ne 37) { throw "Exit code lost: $($result.ExitCode)" }
if ($result.Output -notmatch 'BUILD_WARNING' -or $result.Output -notmatch 'APK=C:') { throw 'Captured build output lost' }
if ($ErrorActionPreference -ne 'Stop') { throw 'Caller error preference changed' }
Write-Output 'CONTRACT_PASS'
`);
  const result = await new Promise((resolve, reject) => {
    const processHandle = spawn(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness]);
    let output = '', stderr = '', released = false;
    processHandle.stdout.on('data', async data => {
      output += data;
      if (!released && output.includes('BUILD_STARTED')) {
        released = true;
        try { await writeFile(gate, 'continue'); } catch (error) { reject(error); }
      }
    });
    processHandle.stderr.on('data', data => { stderr += data; });
    processHandle.on('error', reject);
    processHandle.on('close', code => resolve({ code, output, stderr, released }));
  });
  assert.equal(result.code, 0, result.output + result.stderr);
  assert.ok(result.released, 'Progress must reach the console before the build can finish');
  assert.match(result.output, /CONTRACT_PASS/);
  console.log('Build runner: live progress before completion, stderr capture, failure exit code and APK path PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
