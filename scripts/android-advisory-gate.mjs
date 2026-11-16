import { readFile } from 'node:fs/promises';

// OSV groups aliases for a vulnerability and supplies its highest numeric CVSS score.
async function highFindings(file) {
  const report = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(report.results)) throw Error('Invalid OSV report');
  const findings = new Set();
  for (const result of report.results) {
    for (const entry of result.packages) {
      for (const group of entry.groups ?? []) {
        if (Number(group.max_severity) >= 7) {
          for (const id of group.ids) findings.add(`${entry.package.name} ${id}`);
        }
      }
    }
  }
  return findings;
}

const [current, base] = process.argv.slice(2);
const findings = await highFindings(current);
const previous = base ? await highFindings(base) : new Set();
const added = [...findings].filter(finding => !previous.has(finding));
console.log(`High or critical Android findings: ${findings.size}. New relative to baseline: ${added.length}.`);
if (added.length) {
  for (const finding of added) console.error(finding);
  process.exitCode = 1;
}
