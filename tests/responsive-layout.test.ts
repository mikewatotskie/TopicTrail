import assert from 'node:assert/strict';
import test from 'node:test';
import { getResponsiveLayout } from '../src/core/layout/responsive';
test('compact geometry preserves the mobile frame and target widths', () => {
  assert.equal(getResponsiveLayout(390, 844).mode, 'compact');
  assert.equal(getResponsiveLayout(390, 844).railWidth, 0);
  assert.equal(getResponsiveLayout(390, 844).gutter, 16);
  assert.equal(getResponsiveLayout(390, 844).columns, 1);
});
test('desktop has a rail, adaptive columns and wider document space', () => {
  assert.equal(getResponsiveLayout(1024, 600).railWidth, 232);
  assert.equal(getResponsiveLayout(1366, 768).columns, 3);
  assert.equal(getResponsiveLayout(1920, 1080, 'reader').contentMaxWidth, 1600);
  assert.equal(getResponsiveLayout(1920, 1080, 'form').contentMaxWidth, 800);
});
test('medium and short viewport values are preserved without hard-coded heights', () => {
  assert.equal(getResponsiveLayout(768, 600).mode, 'medium');
  assert.equal(getResponsiveLayout(768, 600).gutter, 24);
  assert.equal(getResponsiveLayout(1366, 600).viewportHeight, 600);
  assert.equal(getResponsiveLayout(NaN, Infinity).columns, 1);
});
