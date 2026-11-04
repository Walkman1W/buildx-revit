import {resolveLocalRuntimes} from './local-runtimes.mjs';
import {readBuildxInstallation} from './buildx-paths.mjs';

// The installer owns this non-secret identifier; absent configuration is a
// legacy development deployment, while malformed configuration is never one.
export async function readInstallationConfiguration(root) {
  return readBuildxInstallation(root);
}

// An installed service uses the same confirmed programs as the Revit add-in,
// even when started manually with unrelated inherited environment variables.
export function resolveInstallationRuntimes(configuration, env=process.env) {
  return resolveLocalRuntimes({env:{...env,BUILDX_CODEX_EXE:configuration.codexExecutable,
    BUILDX_PYTHON_EXE:configuration.pythonExecutable}});
}
