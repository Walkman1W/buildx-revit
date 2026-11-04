import { createSourceMcpServer } from './lib/source-mcp-server.mjs';

// The CLI has no arbitrary root, shell, command or credential flags. Development
// tests inject trusted fixtures into the production server factory instead.
if (process.argv.length > 2) {
  process.stderr.write('BuildX source MCP does not accept command-line options.\n');
  process.exitCode = 1;
} else {
  const made = createSourceMcpServer({ input: process.stdin, output: process.stdout });
  if (!made.ok) {
    process.stderr.write('BuildX source MCP could not initialize its local service.\n');
    process.exitCode = 1;
  } else {
    const server = made.value;
    const stop = async () => {
      const closed = await server.close();
      if (!closed.ok) { process.stderr.write('BuildX source MCP cleanup remains unconfirmed.\n'); process.exitCode = 1; }
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const started = server.start();
    if (!started.ok) await stop();
    const result = await server.finished;
    if (!result.ok) { process.stderr.write('BuildX source MCP cleanup remains unconfirmed.\n'); process.exitCode = 1; }
    // Retain the same server for a signal-triggered cleanup retry after failure.
    if (result.ok) { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  }
}
