import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('experimental batch filter write is not registered or routed', async () => {
  for (const file of ['lib/model-command-catalog.mjs', 'lib/model-tool-dispatch.mjs', 'lib/panel-tools.mjs', 'workbench-mcp.mjs', 'revit-addin/WorkbenchHost.cs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /revit_batch_set_parameters_by_filter|batch_set_parameters_by_filter/, file);
  }
});
