import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../src/worker/browser.ts', import.meta.url), 'utf8');
const start = source.indexOf('          const controls = Array.from(');
const end = source.indexOf('          return { visible, focusable, anyFocusable }', start);
assert.ok(start >= 0 && end > start, 'actual callback anchors');
const body = (source.slice(start, end) + 'return { visible, focusable, anyFocusable };')
  .replace('(el: Element): boolean', '(el)').replace('(el as HTMLElement)', 'el');
function observe(options: {disabled?:boolean; inert?:boolean; hidden?:boolean; tabIndex?:number; ariaDisabled?:boolean} = {}) {
  const el = {
    tabIndex: options.tabIndex ?? 0,
    getBoundingClientRect: () => ({width: options.hidden ? 0 : 100, height:40}),
    getAttribute: (name:string) => name === 'aria-disabled' && options.ariaDisabled ? 'true' : null,
    matches: () => !!options.disabled,
    closest: () => options.inert ? {} : null,
  };
  return runInNewContext('(function(){' + body + '})()', {
    document: {querySelectorAll: () => [el]},
    window: {getComputedStyle: () => ({display:'block', visibility:'visible', opacity:'1'})},
  }, {timeout:1000});
}
for (const [name, options] of Object.entries({disabled:{disabled:true}, inert:{inert:true}, hidden:{hidden:true}, negativeTabIndex:{tabIndex:-1}, ariaDisabled:{ariaDisabled:true}})) {
  test(name + ' does not establish potential focusability', () => {
    const result = observe(options);
    assert.equal(result.focusable, 0);
    assert.equal(result.anyFocusable, false);
  });
}
test('enabled native/custom control is counted once despite selector overlap', () => {
  const result = observe();
  assert.equal(result.visible, 1);
  assert.equal(result.focusable, 1);
  assert.equal(result.anyFocusable, true);
});
test('report explicitly labels heuristic and unavailable observations', () => {
  assert.ok(source.includes("keyboardObservation: 'focusability_heuristic'"));
  assert.ok(source.includes("keyboardObservation: 'unavailable'"));
  const runner = readFileSync(new URL('../src/worker/runner.ts', import.meta.url), 'utf8');
  assert.ok(runner.includes('Tab traversal and keyboard activation were not tested.'));
});
