import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

export function findBrowser() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  if (process.env.BROWSER_PATH && fs.existsSync(process.env.BROWSER_PATH)) return process.env.BROWSER_PATH;

  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const port = s.address().port;
    s.close(() => resolve(port));
  });
  s.on('error', reject);
});

export async function launchBrowser(options = {}) {
  const browserPath = options.browserPath || findBrowser();
  if (!browserPath) {
    throw new Error('No supported browser found (Chrome or Edge). Set CHROME_BIN or BROWSER_PATH.');
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-user-data-'));
  const port = await freePort();

  const chromeArgs = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-popup-blocking',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-crash-upload',
    '--safebrowsing-disable-auto-update',
    'about:blank',
    ...(options.args || [])
  ];

  const proc = cp.spawn(browserPath, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  let pageTarget = null;
  const startWait = Date.now();
  while (Date.now() - startWait < (options.launchTimeoutMs || 15000)) {
    await new Promise(r => setTimeout(r, 150));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        pageTarget = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        if (pageTarget) break;
      }
    } catch {}
  }

  if (!pageTarget) {
    try {
      if (process.platform === 'win32') cp.execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
      else proc.kill('SIGKILL');
    } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    throw new Error(`Failed to connect to browser CDP target on port ${port}`);
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let msgId = 1;
  const pending = new Map();
  const consoleErrors = [];

  ws.onmessage = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }

    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
      else resolve(data.result);
      return;
    }

    if (data.method === 'Runtime.consoleAPICalled') {
      if (data.params.type === 'error') {
        const text = data.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
        consoleErrors.push(text);
      }
    } else if (data.method === 'Runtime.exceptionThrown') {
      const desc = data.params.exceptionDetails?.exception?.description || data.params.exceptionDetails?.text || 'Uncaught exception';
      consoleErrors.push(desc);
    }
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const evaluate = async (fnOrStr, ...args) => {
    const expression = typeof fnOrStr === 'function'
      ? `(${fnOrStr.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`
      : fnOrStr;
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`Evaluation failed: ${desc}`);
    }
    return res.result?.value;
  };

  const navigate = async (url, { timeout = 15000 } = {}) => {
    let loaded = false;
    const loadPromise = new Promise((resolve) => {
      const handler = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.method === 'Page.loadEventFired') {
            ws.removeEventListener('message', handler);
            loaded = true;
            resolve();
          }
        } catch {}
      };
      ws.addEventListener('message', handler);
    });

    await send('Page.navigate', { url });

    await Promise.race([
      loadPromise,
      (async () => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          try {
            const ready = await evaluate(() => document.readyState === 'complete');
            if (ready) return;
          } catch {}
          await new Promise(r => setTimeout(r, 100));
        }
        if (!loaded) throw new Error(`Navigation timeout after ${timeout}ms: ${url}`);
      })()
    ]);
  };

  const waitFor = async (selectorOrFn, { timeout = 10000, interval = 50 } = {}) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        let ok = false;
        if (typeof selectorOrFn === 'string') {
          ok = await evaluate((sel) => {
            const el = document.querySelector(sel);
            return el !== null;
          }, selectorOrFn);
        } else {
          ok = await evaluate(selectorOrFn);
        }
        if (ok) return true;
      } catch {}
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`Timeout after ${timeout}ms waiting for: ${selectorOrFn}`);
  };

  const click = async (selector, { timeout = 10000 } = {}) => {
    await waitFor(selector, { timeout });
    await evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found for click: ${sel}`);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.click();
    }, selector);
  };

  const type = async (selector, text, { timeout = 10000 } = {}) => {
    await waitFor(selector, { timeout });
    await evaluate((sel, val) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found for type: ${sel}`);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, selector, text);
  };

  const selectOption = async (selector, value, { timeout = 10000 } = {}) => {
    await waitFor(selector, { timeout });
    await evaluate((sel, val) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found for select: ${sel}`);
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, selector, value);
  };

  const screenshot = async ({ path: outPath } = {}) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(res.data, 'base64');
    if (outPath) {
      fs.writeFileSync(outPath, buf);
    }
    return buf;
  };

  const close = async () => {
    try {
      ws.close();
    } catch {}
    if (proc?.pid) {
      if (process.platform === 'win32') {
        try {
          cp.execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
        } catch {}
      } else {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }
    }
    await new Promise(r => setTimeout(r, 400));
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  };

  return {
    proc,
    port,
    userDataDir,
    ws,
    send,
    navigate,
    evaluate,
    waitFor,
    click,
    type,
    selectOption,
    screenshot,
    getConsoleErrors: () => [...consoleErrors],
    clearConsoleErrors: () => { consoleErrors.length = 0; },
    close
  };
}
