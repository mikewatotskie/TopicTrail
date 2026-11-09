import React, { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TTSearchInput } from '../../src/components/TTInput';

// Real browser geometry + behavior for the shared input; no DOM style-mirroring assertion.
const labels = ['Search documents', 'Search saved resources', 'Wikipedia topic query'];
let root: Root | undefined;
function Harness() {
  const [values, setValues] = useState(['', '', '']);
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 640, gap: 16 } },
    ...labels.map((label, index) => React.createElement('section', { key: label, 'data-search-case': label },
      React.createElement(TTSearchInput, { accessibilityLabel: label, value: values[index],
        onChangeText: (value: string) => setValues(current => current.map((prior, i) => i === index ? value : prior)) }),
      React.createElement('output', { 'data-value-for': label, style: { overflowWrap: 'anywhere' } }, values[index]))));
}
export function mountSearchInputs() {
  root?.unmount();
  root = createRoot(document.querySelector('main')!);
  flushSync(() => root!.render(React.createElement(Harness)));
}
const rect = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }; };
export function runSearchInputCases() {
  mountSearchInputs();
  const results = [];
  for (const label of labels) {
    const scope = [...document.querySelectorAll<HTMLElement>('section')].find(e => e.dataset.searchCase === label)!;
    const input = scope.querySelector('input')!;
    const measure = () => {
      const inputRect = rect(input), parent = rect(input.parentElement!);
      const clear = scope.querySelector('[aria-label="Clear search"]');
      return { input: inputRect, parent, ...(clear ? { clear: rect(clear) } : {}),
        fits: inputRect.x >= parent.x - .5 && inputRect.right <= parent.right + .5 && inputRect.right <= innerWidth + .5 && inputRect.height >= 48,
        value: input.value, focused: document.activeElement === input };
    };
    const empty = measure();
    flushSync(() => input.focus()); const focused = measure();
    const value = 'Fictional Unicode 日本語 ' + 'long-query-'.repeat(30);
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const filled = measure(), observed = scope.querySelector('output')!.textContent;
    const clear = scope.querySelector<HTMLElement>('[aria-label="Clear search"]');
    if (clear) flushSync(() => clear.click());
    const cleared = measure();
    results.push({ label, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, empty, focused, filled, cleared,
      passed: empty.fits && focused.fits && focused.focused && filled.fits && observed === value && !!clear
        && !!filled.clear && filled.clear.right <= filled.parent.right + .5 && cleared.value === ''
        && !scope.querySelector('[aria-label="Clear search"]') });
  }
  return results;
}
