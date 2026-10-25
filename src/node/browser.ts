// Opens a URL in the user's browser. Honours $BROWSER (a command; "false"/"none" means don't),
// else the platform opener. Failure is a warning, never fatal: agents often have no display,
// and the URL is on stderr for a human to open.
import { spawn } from 'node:child_process';

export function openBrowser(url: string, log: (msg: string) => void): void {
  const custom = process.env['BROWSER'];
  if (custom !== undefined && custom !== '') {
    if (/^(false|none|0|no)$/i.test(custom.trim())) return;
    launch(custom, [url], true, log);
    return;
  }
  const opener = { darwin: 'open', win32: 'start' }[process.platform as string] ?? 'xdg-open';
  launch(opener, [url], process.platform === 'win32', log);
}

function launch(cmd: string, args: string[], shell: boolean, log: (msg: string) => void): void {
  try {
    const child = spawn(shell ? `${cmd} ${args.map(quote).join(' ')}` : cmd, shell ? [] : args, { shell, stdio: 'ignore', detached: true });
    child.on('error', (e) => log(`could not open a browser (${e.message}); open the URL yourself`));
    child.unref();
  } catch (e) {
    log(`could not open a browser (${(e as Error).message}); open the URL yourself`);
  }
}

function quote(s: string): string {
  return process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`;
}
