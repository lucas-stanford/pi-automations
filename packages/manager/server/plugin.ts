/**
 * The `manager` plugin: adds an Edit action that starts the server on first use and opens the browser.
 * A run's worker loads plugins too, so the server is only imported when Edit is chosen.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { PiAutomationsPlugin } from '../../../dist/plugins/types.js';
import { editorPath } from './ids';

/** Not through `cmd /c start` on Windows, where an `&` in the URL would end the command. */
function openBrowser(url: string): void {
  const [file, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Best effort: the URL is in the action's message.
  }
}

const plugin: PiAutomationsPlugin = {
  name: 'manager',
  setup(api) {
    // A worker only reports runs; there is nothing here for it.
    if (api.where === 'worker') return;

    let starting: Promise<import('./server').ManagerServer> | undefined;
    const server = () => {
      starting ??= import('./server')
        .then(({ startManagerServer, webRootAt }) =>
          startManagerServer({ host: api.host, webRoot: webRootAt(fileURLToPath(new URL('../dist/', import.meta.url))) }),
        )
        .catch((e: unknown) => {
          starting = undefined;
          throw e;
        });
      return starting;
    };

    api.addAction({
      id: 'edit',
      label: 'Edit in the Automation Manager',
      description: 'Open it in the Automation Manager, in your browser.',
      async run(ctx) {
        const s = await server();
        const url = ctx.automation ? `${s.url}${editorPath(ctx.automation.key)}` : s.url;
        if (ctx.open) openBrowser(url);
        return { message: `Automation Manager: ${url}`, url, keepAlive: true };
      },
    });

    api.on('shutdown', async () => {
      const s = await starting?.catch(() => undefined);
      starting = undefined;
      await s?.close();
    });
  },
};

export default plugin;
