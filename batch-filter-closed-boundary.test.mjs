import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('experimental batch filter write is not registered or routed', async () => {
  for (const file of ['lib/model-command-catalog.mjs', 'lib/model-tool-dispatch.mjs', 'lib/panel-tools.mjs', 'workbench-mcp.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /revit_batch_set_parameters_by_filter|batch_set_parameters_by_filter/, file);
  }
});

test('host batch write gate rejects before any permit consumption or transaction', async () => {
  const source = await readFile(new URL('revit-addin/WorkbenchHost.cs', import.meta.url), 'utf8');
  assert.match(source, /#else\s*throw new InvalidOperationException\("Batch filter writes are disabled/);
  const dispatch = source.slice(source.indexOf('private object Dispatch(UIApplication'));
  assert.match(dispatch, /#if BUILDX_BATCH_FIXTURE[\s\S]*DispatchClosedBatchWriteCandidate\s*\([\s\S]*#else[\s\S]*Batch filter writes are disabled[\s\S]*#endif/);
  const build = await readFile(new URL("revit-addin/build.ps1", import.meta.url), "utf8");
  assert.doesNotMatch(build, /BUILDX_BATCH_FIXTURE/);
});
