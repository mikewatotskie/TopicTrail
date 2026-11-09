import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { androidRoleSets } from './helpers/accessibility';
import { auditAccessibility } from './helpers/accessibilityAudit';

test('installed native enum rejects the original status role despite permissive generated TS declarations', () => {
  const roles = androidRoleSets();
  assert.equal(roles.accessibilityRole.includes('status'), false);
  assert.ok(roles.accessibilityRole.includes('alert') && roles.role.includes('status'));
});

test('static audit rejects dynamic roles, malformed values and unsafe spread order, while allowing web-only semantics', () => {
  const path = resolve('tests/accessibility-audit-fixture.tsx');
  const snippets = [
    `<Text accessibilityRole="status" />`,
    `<Text accessibilityRole={busy ? 'alert' : 'status'} />`,
    `<Text accessibilityRole={dynamic} />`,
    `<Text accessibilityRole={42 as any} />`,
    `<Text {...{accessibilityRole:'status'}} />`,
    `<Text accessibilityRole="button" {...incoming} />`,
    `<Text {...{...{role:'bogus'}}} />`,
    `<Text {...{['accessibility'+'Role']: dynamic}} />`,
    `React.createElement(Text, {accessibilityRole: 'status'})`,
  ];
  const safe = [
    `<Text accessibilityRole={busy ? 'alert' : undefined} />`,
    `<Text {...incoming} accessibilityRole="button" role={undefined} />`,
    `<Text {...{role:'bogus', accessibilityRole:'status', ...{role:undefined, accessibilityRole:'button'}}} />`,
    `<Text accessibilityRole={Platform.OS === 'web' ? 'status' : undefined} />`,
    `<Text role={web ? 'status' : undefined} accessibilityRole={!web ? 'alert' : undefined} />`,
    `<Text {...(web ? {role:'status'} : {accessibilityRole:'alert'})} />`,
    `<Text accessibilityRole={valid} />`,
  ];
  const prefix = `import React from 'react';import {Text,Platform} from 'react-native';declare const busy:boolean;declare const dynamic:string;declare const incoming:any;declare const valid:'button'|'alert'|undefined;const web=Platform.OS==='web';\n`;
  const content = prefix + [...snippets, ...safe].map((code, i) => `export const C${i}=()=>${code};`).join('\n');
  const report = auditAccessibility([path], { [path]: content });
  for (let i = 0; i < snippets.length; i++) assert.ok(report.issues.some(issue => issue.includes(`:${i + 2} android `)), `must reject ${snippets[i]}`);
  for (let i = 0; i < safe.length; i++) assert.ok(!report.issues.some(issue => issue.includes(`:${i + snippets.length + 2} `)), `must accept ${safe[i]}: ${report.issues}`);
});

test('all application JS/TS role assignments and JSX spreads satisfy the installed native contract', context => {
  function walk(path: string): string[] {
    return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path + '/' + entry.name)
      : /\.[jt]sx?$/.test(entry.name) ? [resolve(path, entry.name)] : []);
  }
  const report = auditAccessibility([...walk('src'), resolve('App.tsx'), resolve('index.ts')]);
  assert.ok(report.files >= 157 && report.assignments >= 42 && report.spreads >= 10, 'audit must traverse the whole application');
  assert.deepEqual(report.issues, []);
  context.diagnostic(JSON.stringify(report));
});
