import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import test from 'node:test';

test('Android study archive encryption, framing, and integrity with synthetic originals', { timeout: 120_000 }, () => {
  const scratch = join(process.cwd(), 'work', 'study-transfer-tests');
  mkdirSync(scratch, { recursive: true });
  const run = mkdtempSync(join(scratch, 'archive-'));
  try {
    const compile = spawnSync('javac', ['--release', '11', '-encoding', 'UTF-8', '-d', run,
      'android/app/src/main/java/com/teamjam/topictrail/acceptance/StudyArchive.java',
      'tests/android/StudyArchiveCheck.java'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
    const check = spawnSync('java', ['-cp', run, 'com.teamjam.topictrail.acceptance.StudyArchiveCheck', run],
      { encoding: 'utf8', timeout: 60_000 });
    assert.equal(check.status, 0, check.error?.message ?? check.stderr);
    assert.match(check.stdout, /Passed \d+ checks/);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
