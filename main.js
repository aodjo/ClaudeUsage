const { app, BrowserWindow, ipcMain, Menu, powerMonitor, screen } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'; /** Claude OAuth endpoint that reports plan usage limits. */
const POLL_MS = 2 * 60 * 1000; /** Interval between automatic usage fetches, in milliseconds. */
const WIDTH = 260; /** Fixed content width of the widget window, in pixels. */

let win; /** The floating widget window. */
let timer; /** Handle of the next scheduled poll. */
let inFlight = false; /** Whether a usage request is currently in progress. */
let last = null; /** Last successful usage response and the time it was fetched. */
let saveTimer; /** Handle of the pending debounced window-position save. */

/**
 * Reads Claude Code's credentials JSON from the macOS keychain.
 *
 * Shells out to the `security` CLI and looks up the generic password stored under the
 * "Claude Code-credentials" service. Any failure (item missing, access denied, non-macOS
 * host) resolves to null instead of rejecting.
 *
 * @async
 * @returns {Promise<?string>} The raw credentials JSON, or null if it could not be read.
 *
 * @example
 * const raw = await readKeychain();
 * console.log(raw?.startsWith('{"claudeAiOauth"')); // true
 */
function readKeychain() {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/**
 * Reads Claude Code's credentials JSON from disk.
 *
 * Windows and Linux keep credentials in `.credentials.json` inside the Claude config
 * directory, which is `CLAUDE_CONFIG_DIR` when set and `~/.claude` otherwise. A missing
 * or unreadable file yields null.
 *
 * @returns {?string} The raw credentials JSON, or null if the file could not be read.
 *
 * @example
 * const raw = readCredentialsFile();
 * console.log(raw === null); // true if Claude Code has never logged in on this machine
 */
function readCredentialsFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    return fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Loads the OAuth credentials that Claude Code saved at login.
 *
 * On macOS the keychain is tried first and the credentials file is the fallback; on other
 * platforms only the file is read. The store is re-read on every call, so tokens that
 * Claude Code refreshes are picked up without restarting the widget. Malformed JSON is
 * treated the same as missing credentials. The entry holds `accessToken`, `refreshToken`
 * and `expiresAt` (Unix time in milliseconds).
 *
 * @async
 * @returns {Promise<?{accessToken: string, refreshToken: string, expiresAt: number}>} The
 *   `claudeAiOauth` entry, or null if none is available.
 *
 * @example
 * const creds = await readCredentials();
 * console.log(typeof creds?.accessToken); // 'string'
 */
async function readCredentials() {
  const raw = (process.platform === 'darwin' && (await readKeychain())) || readCredentialsFile();
  try {
    return raw ? JSON.parse(raw).claudeAiOauth ?? null : null;
  } catch {
    return null;
  }
}

/**
 * Requests the current plan usage from the Claude OAuth usage endpoint.
 *
 * Expected failures (no credentials, expired token, 401, 429 and other HTTP errors) are
 * returned as an `error` message rather than thrown. The access token is never refreshed
 * here: refreshing rotates the refresh token and would sign Claude Code out, so an expired
 * token is reported and the widget waits for Claude Code to renew it.
 *
 * On failure, `error` is a Korean message for the widget, `retryAfter` carries the seconds
 * from a 429 response's Retry-After header, and `signedOut` is true when there is no usable
 * login, so earlier numbers must not be shown.
 *
 * @async
 * @returns {Promise<{data?: Object, error?: string, retryAfter?: number, signedOut?: boolean}>}
 *   The parsed usage response as `data`, or the failure details.
 * @throws {Error} If the request fails at the network level, times out after 15 seconds,
 *   or the response body is not valid JSON.
 *
 * @example
 * const { data, error } = await fetchUsage();
 * console.log(error ?? data.five_hour.utilization); // 8
 */
async function fetchUsage() {
  const creds = await readCredentials();
  if (!creds?.accessToken) {
    return { error: 'Claude Code 로그인 정보가 없습니다. claude에서 /login 하세요.', signedOut: true };
  }
  if (creds.expiresAt && creds.expiresAt < Date.now()) {
    return { error: '토큰이 만료됐습니다. Claude Code를 실행하면 갱신됩니다.' };
  }

  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) return { error: '인증 실패(401). Claude Code에서 다시 로그인하세요.', signedOut: true };
  if (res.status === 429) {
    return { error: '요청 제한(429). 잠시 후 다시 시도합니다.', retryAfter: Number(res.headers.get('retry-after')) || 0 };
  }
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return { data: await res.json() };
}

/**
 * Fetches usage, sends the result to the renderer, and schedules the next fetch.
 *
 * Calls made while a request is already in flight are ignored. A failed fetch keeps the
 * last successful data and sends it together with the error, so the widget keeps showing
 * the previous numbers. The exception is a signed-out failure: the old numbers are dropped,
 * because the next login may be a different account. The next run is scheduled after
 * POLL_MS, or after the server's Retry-After delay when that is longer.
 *
 * @async
 * @returns {Promise<void>} Resolves once the result is sent and the next poll is scheduled.
 *
 * @example
 * await poll(); // the renderer receives { data, fetchedAt, error } on the 'usage' channel
 */
async function poll() {
  if (inFlight) return;
  inFlight = true;
  clearTimeout(timer);

  let result;
  try {
    result = await fetchUsage();
  } catch (e) {
    result = { error: `네트워크 오류: ${e.message}` };
  }
  inFlight = false;

  if (result.data) last = { data: result.data, fetchedAt: Date.now() };
  else if (result.signedOut) last = null;
  if (win && !win.isDestroyed()) win.webContents.send('usage', { ...last, error: result.error ?? null });
  timer = setTimeout(poll, Math.max(POLL_MS, (result.retryAfter ?? 0) * 1000));
}

/**
 * Returns the path of the file that remembers the window position.
 *
 * The file lives in Electron's per-app userData directory, so the path is only valid
 * once the app is ready.
 *
 * @returns {string} Absolute path to `window.json`.
 *
 * @example
 * console.log(statePath()); // '/Users/me/Library/Application Support/claude-usage-widget/window.json'
 */
function statePath() {
  return path.join(app.getPath('userData'), 'window.json');
}

/**
 * Decides where the widget window should open.
 *
 * Restores the saved position when it still falls inside the work area of a connected
 * display, which guards against a monitor having been unplugged since the last run.
 * Otherwise the window goes 20px in from the top-right corner of the primary display.
 *
 * @returns {{x: number, y: number}} Screen coordinates for the window's top-left corner.
 *
 * @example
 * const { x, y } = loadPosition();
 * console.log(x, y); // 940 163
 */
function loadPosition() {
  try {
    const { x, y } = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
      x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height);
    if (onScreen) return { x, y };
  } catch {}
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - WIDTH - 20, y: workArea.y + 20 };
}

/**
 * Saves the current window position after the window stops moving.
 *
 * Runs on every `move` event but only writes once the window has been still for 500ms,
 * so one drag produces one write. Write errors are ignored.
 *
 * @returns {void}
 *
 * @example
 * win.on('move', savePosition);
 */
function savePosition() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const [x, y] = win.getPosition();
    fs.writeFile(statePath(), JSON.stringify({ x, y }), () => {});
  }, 500);
}

/**
 * Opens the widget's context menu.
 *
 * Offers an immediate refresh, an always-on-top toggle, and Quit. Quit is the only way to
 * exit, because the widget has no dock or taskbar entry.
 *
 * @returns {void}
 *
 * @example
 * ipcMain.on('menu', showMenu);
 */
function showMenu() {
  Menu.buildFromTemplate([
    { label: '지금 새로고침', click: poll },
    {
      label: '항상 위에',
      type: 'checkbox',
      checked: win.isAlwaysOnTop(),
      click: (item) => win.setAlwaysOnTop(item.checked, 'floating'),
    },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]).popup({ window: win });
}

/**
 * Replaces the Windows system menu with the widget's context menu.
 *
 * On Windows, right-clicking a drag region opens the native system menu and the page never
 * receives a `contextmenu` event. This handler cancels the system menu and shows the widget
 * menu instead. Other platforms never emit this event.
 *
 * @param {Electron.Event} event - The window's `system-context-menu` event.
 * @returns {void}
 *
 * @example
 * win.on('system-context-menu', onSystemContextMenu);
 */
function onSystemContextMenu(event) {
  event.preventDefault();
  showMenu();
}

/**
 * Resizes the window to the height of the rendered widget.
 *
 * The width stays fixed at WIDTH. The height is rounded up so the card is never clipped.
 *
 * @param {Electron.IpcMainEvent} _event - The IPC event (unused).
 * @param {number} height - Height of the widget card in CSS pixels.
 * @returns {void}
 *
 * @example
 * ipcMain.on('resize', fitToContent);
 */
function fitToContent(_event, height) {
  win.setContentSize(WIDTH, Math.ceil(height));
}

/**
 * Creates the frameless, transparent, always-on-top widget window.
 *
 * The window appears without taking focus, stays visible on every workspace and above
 * full-screen apps, and starts polling once the page has loaded. Moving it saves the new
 * position.
 *
 * @returns {void}
 *
 * @example
 * app.whenReady().then(createWindow);
 */
function createWindow() {
  win = new BrowserWindow({
    ...loadPosition(),
    width: WIDTH,
    height: 150,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');

  win.once('ready-to-show', () => win.showInactive());
  win.webContents.once('did-finish-load', poll);
  win.on('move', savePosition);
  win.on('system-context-menu', onSystemContextMenu);
}

/**
 * Starts the widget once Electron is ready.
 *
 * Hides the macOS dock icon, connects the renderer's IPC messages, refreshes when the
 * system wakes from sleep, and opens the window.
 *
 * @returns {void}
 *
 * @example
 * app.whenReady().then(start);
 */
function start() {
  if (process.platform === 'darwin') app.dock.hide();

  ipcMain.on('refresh', poll);
  ipcMain.on('menu', showMenu);
  ipcMain.on('resize', fitToContent);
  powerMonitor.on('resume', poll);

  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}
