import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';

const files = ['styles.css', ...(await readdir('web')).filter(name => name.endsWith('.css')).map(name => 'web/' + name)];
for (const file of files) {
  test(`${file}: no forced cascade, relational selectors or flagged compatibility properties`, async () => {
    const css = await readFile(file, 'utf8');
    assert.doesNotMatch(css, /!important|:has\(|clip-path\s*:|column-gap\s*:/i);
  });
}

test('nested prototype dialogs retain scroll lock until both close', async () => {
  const source = await readFile('web/flow-options.mjs', 'utf8');
  const body = source.match(/function syncDialogState\(\)\{([^\n]+)\}/)?.[1];
  assert.ok(body);
  const setup = source.slice(source.indexOf('function syncDialogState'), source.indexOf('const tree='));
  const listeners = [];
  vm.runInNewContext(setup, { $: selector => ({ addEventListener: event => listeners.push([selector, event]) }) });
  assert.deepEqual(listeners, [['#config', 'close'], ['#picker', 'close']]);
  let locked = false;
  const context = {
    config: { open: false }, picker: { open: false },
    document: { body: { classList: { toggle(name, value) { assert.equal(name, 'has-open-dialog'); locked = value; } } } },
  };
  for (const [config, picker, expected] of [[true,false,true],[true,true,true],[true,false,true],[false,true,true],[false,false,false]]) {
    context.config.open = config; context.picker.open = picker;
    vm.runInNewContext(body, context);
    assert.equal(locked, expected);
  }
  assert.match(source, /dialog\.addEventListener\('close',syncDialogState\)/);
  assert.match(source, /openDialog\(config\)/);
  assert.match(source, /openDialog\(picker\)/);
});

test('path fields expose an explicit layout class instead of :has', async () => {
  const source = await readFile('web/flow-options.mjs', 'utf8');
  const field = source.match(/function field\([^]*?\n\}/)?.[0];
  assert.ok(field);
  const context = {};
  vm.runInNewContext(field + ';result = field("Source",\'<button class="path-choice">Folder</button>\');', context);
  assert.match(context.result, /flow-field\s+is-path-field/);
  vm.runInNewContext('result = field("Count", "<select></select>");', context);
  assert.doesNotMatch(context.result, /is-path-field/);
});
