const { app, BrowserWindow, ipcMain, Menu, powerMonitor, screen, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const POLL_MS = 2 * 60 * 1000; /** Interval between automatic usage fetches, in milliseconds. */
const WIDTH = 260; /** Fixed content width of the widget window, in pixels. */
const WEB_ORIGIN = 'https://claude.ai'; /** claude.ai origin the widget logs in to and reads usage from. */
const WEB_PARTITION = 'persist:claude'; /** Persistent session partition that holds the widget's claude.ai login. */
const LOGIN_EXPIRED = 'claude.ai 로그인이 만료됐습니다. 다시 로그인하세요.'; /** Message shown when claude.ai rejects the stored login. */

let win; /** The floating widget window. */
let loginWin = null; /** The claude.ai login window while it is open. */
let timer; /** Handle of the next scheduled poll. */
let inFlight = false; /** Whether a usage request is currently in progress. */
let pollAgain = false; /** Whether another fetch was requested while one was in progress. */
let last = null; /** Last successful usage response and the time it was fetched. */
let saveTimer; /** Handle of the pending debounced window-position save. */

/**
 * Turns a failed usage response into the error details shown by the widget.
 *
 * 401 and 403 mean the login is no longer valid, so the result is marked as signed out.
 * 429 carries the Retry-After delay so the next poll can back off. Any other status is
 * reported by its code.
 *
 * @param {Response} res - The non-OK response.
 * @returns {{error: string, retryAfter?: number, signedOut?: boolean}} The failure details.
 *
 * @example
 * responseError(new Response(null, { status: 401 }));
 * // { error: 'claude.ai 로그인이 만료됐습니다. 다시 로그인하세요.', signedOut: true }
 */
function responseError(res) {
  if (res.status === 401 || res.status === 403) return { error: LOGIN_EXPIRED, signedOut: true };
  if (res.status === 429) {
    return { error: '요청 제한(429). 잠시 후 다시 시도합니다.', retryAfter: Number(res.headers.get('retry-after')) || 0 };
  }
  return { error: `HTTP ${res.status}` };
}

/**
 * Returns the Electron session that holds the widget's own claude.ai login.
 *
 * The session is persisted under WEB_PARTITION, so the login survives restarts and is
 * kept apart from the widget window's default session.
 *
 * @returns {Electron.Session} The claude.ai session.
 *
 * @example
 * const cookies = await webSession().cookies.get({ url: WEB_ORIGIN });
 */
function webSession() {
  return session.fromPartition(WEB_PARTITION);
}

/**
 * Sends a GET request to claude.ai with the widget's claude.ai login.
 *
 * The request goes through Chromium's network stack with the session's cookies, so it
 * looks like the claude.ai web app calling its own API.
 *
 * @async
 * @param {string} pathname - Path on claude.ai, starting with a slash.
 * @returns {Promise<Response>} The response.
 * @throws {Error} If the request fails at the network level or times out after 15 seconds.
 *
 * @example
 * const res = await webFetch('/api/organizations');
 * console.log(res.status); // 200
 */
function webFetch(pathname) {
  return webSession().fetch(`${WEB_ORIGIN}${pathname}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * Tells whether the widget is logged in to claude.ai.
 *
 * Checks for the `sessionKey` cookie that claude.ai sets at login. The cookie existing
 * does not guarantee the server still accepts it; an expired login shows up as a 401 or
 * 403 on the next request.
 *
 * @async
 * @returns {Promise<boolean>} True when a claude.ai session cookie is stored.
 *
 * @example
 * if (await hasWebLogin()) console.log('claude.ai login found');
 */
async function hasWebLogin() {
  const cookies = await webSession().cookies.get({ url: WEB_ORIGIN, name: 'sessionKey' });
  return cookies.length > 0;
}

/**
 * Finds the claude.ai organization whose usage should be shown.
 *
 * Uses the `lastActiveOrg` cookie, which claude.ai sets to the organization the user last
 * had open. Without it, lists the account's organizations and picks the first one that
 * can chat, falling back to the first one.
 *
 * @async
 * @returns {Promise<?string>} The organization UUID, or null if it could not be determined.
 * @throws {Error} If the organization list request fails at the network level.
 *
 * @example
 * const orgId = await webOrganizationId();
 * console.log(orgId); // '1671290f-6105-491c-bdd5-5bafdf071264'
 */
async function webOrganizationId() {
  const [cookie] = await webSession().cookies.get({ url: WEB_ORIGIN, name: 'lastActiveOrg' });
  if (cookie?.value) return cookie.value;

  const res = await webFetch('/api/organizations');
  if (!res.ok) return null;
  const orgs = await res.json();
  const org = orgs.find((o) => o.capabilities?.includes('chat')) ?? orgs[0];
  return org?.uuid ?? null;
}

/**
 * Requests the current plan usage with the widget's claude.ai login.
 *
 * Calls the same usage API the claude.ai settings page uses, for the organization picked
 * by webOrganizationId. Expected failures are returned as an `error` message rather than
 * thrown. Having no login, or a login claude.ai rejects, is marked as signed out so the
 * widget drops old numbers and shows its login button.
 *
 * @async
 * @returns {Promise<{data?: Object, error?: string, retryAfter?: number, signedOut?: boolean}>}
 *   The parsed usage response as `data`, or the failure details.
 * @throws {Error} If a request fails at the network level, times out after 15 seconds, or
 *   the response body is not valid JSON.
 *
 * @example
 * const { data, error } = await fetchUsage();
 * console.log(error ?? data.five_hour.utilization); // 9
 */
async function fetchUsage() {
  if (!(await hasWebLogin())) return { error: 'claude.ai에 로그인하세요.', signedOut: true };

  const orgId = await webOrganizationId();
  if (!orgId) return { error: LOGIN_EXPIRED, signedOut: true };

  const res = await webFetch(`/api/organizations/${orgId}/usage`);
  if (!res.ok) return responseError(res);
  return { data: await res.json() };
}

/**
 * Fetches usage, sends the result to the renderer, and schedules the next fetch.
 *
 * A call made while a request is in flight is not dropped: one more fetch runs as soon as
 * the current one finishes, so a login or logout is always reflected. A failed fetch keeps the
 * last successful data and sends it together with the error, so the widget keeps showing
 * the previous numbers. The exception is a signed-out failure: the old numbers are dropped,
 * because the next login may be a different account. The next run is scheduled after
 * POLL_MS, or after the server's Retry-After delay when that is longer.
 *
 * @async
 * @returns {Promise<void>} Resolves once the result is sent and the next poll is scheduled.
 *
 * @example
 * await poll(); // the renderer receives { data, fetchedAt, error, signedOut } on the 'usage' channel
 */
async function poll() {
  if (inFlight) {
    pollAgain = true;
    return;
  }
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
  if (win && !win.isDestroyed()) {
    win.webContents.send('usage', { ...last, error: result.error ?? null, signedOut: Boolean(result.signedOut) });
  }
  if (pollAgain) {
    pollAgain = false;
    poll();
    return;
  }
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
 * Returns the user agent of a regular Chrome browser.
 *
 * Electron's default user agent names the app and Electron, and some sign-in providers,
 * notably Google, refuse to sign in from embedded browsers they recognise that way.
 * Removing those two tokens leaves the plain Chrome user agent of the bundled Chromium.
 *
 * @returns {string} The user agent without the app and Electron tokens.
 *
 * @example
 * browserUserAgent(); // 'Mozilla/5.0 (Macintosh; ...) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/... Safari/537.36'
 */
function browserUserAgent() {
  return webSession()
    .getUserAgent()
    .split(' ')
    .filter((token) => !token.startsWith('Electron/') && !token.startsWith(`${app.getName()}/`))
    .join(' ');
}

/**
 * Opens a window for logging in to claude.ai.
 *
 * The window uses the widget's claude.ai session, so the login is stored there and not in
 * any browser. If the window is already open it is brought to the front instead. It closes
 * itself once the login completes; see onWebCookieChanged.
 *
 * @returns {void}
 *
 * @example
 * ipcMain.on('login', openLoginWindow);
 */
function openLoginWindow() {
  if (loginWin) {
    loginWin.focus();
    return;
  }
  loginWin = new BrowserWindow({
    width: 460,
    height: 700,
    title: 'claude.ai 로그인',
    show: false,
    webPreferences: { partition: WEB_PARTITION },
  });
  loginWin.loadURL(`${WEB_ORIGIN}/login`);
  loginWin.once('ready-to-show', () => {
    loginWin.show();
    app.focus({ steal: true });
  });
  loginWin.on('closed', () => {
    loginWin = null;
  });
}

/**
 * Finishes a claude.ai login once its session cookie appears.
 *
 * Only reacts while the login window is open, so routine cookie updates during normal use
 * are ignored. When claude.ai sets `sessionKey`, the login window closes and usage is
 * fetched right away with the new login.
 *
 * @param {Electron.Event} _event - The cookie event (unused).
 * @param {Electron.Cookie} cookie - The cookie that changed.
 * @param {string} _cause - Why the cookie changed (unused).
 * @param {boolean} removed - Whether the cookie was removed.
 * @returns {void}
 *
 * @example
 * webSession().cookies.on('changed', onWebCookieChanged);
 */
function onWebCookieChanged(_event, cookie, _cause, removed) {
  if (!loginWin || removed || cookie.name !== 'sessionKey') return;
  loginWin.close();
  poll();
}

/**
 * Logs the widget out of claude.ai.
 *
 * Clears every cookie and all storage of the widget's claude.ai session and drops the
 * numbers fetched with it. The widget then shows its login button again.
 *
 * @async
 * @returns {Promise<void>} Resolves once the session is cleared and a new fetch has started.
 *
 * @example
 * await logoutWeb();
 */
async function logoutWeb() {
  await webSession().clearStorageData();
  last = null;
  poll();
}

/**
 * Opens the widget's context menu.
 *
 * Offers an immediate refresh, an always-on-top toggle, logging in to or out of claude.ai
 * depending on the current state, and Quit. Quit is the only way to exit, because the
 * widget has no dock or taskbar entry.
 *
 * @async
 * @returns {Promise<void>} Resolves once the menu has been shown.
 *
 * @example
 * ipcMain.on('menu', showMenu);
 */
async function showMenu() {
  const account = (await hasWebLogin())
    ? { label: 'claude.ai 로그아웃', click: logoutWeb }
    : { label: 'claude.ai 로그인…', click: openLoginWindow };

  Menu.buildFromTemplate([
    { label: '지금 새로고침', click: poll },
    {
      label: '항상 위에',
      type: 'checkbox',
      checked: win.isAlwaysOnTop(),
      click: (item) => win.setAlwaysOnTop(item.checked, 'floating'),
    },
    { type: 'separator' },
    account,
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
 * Hides the macOS dock icon, prepares the claude.ai session, connects the renderer's IPC
 * messages, refreshes when the system wakes from sleep, and opens the window.
 *
 * @returns {void}
 *
 * @example
 * app.whenReady().then(start);
 */
function start() {
  if (process.platform === 'darwin') app.dock.hide();

  webSession().setUserAgent(browserUserAgent());
  webSession().cookies.on('changed', onWebCookieChanged);

  ipcMain.on('refresh', poll);
  ipcMain.on('menu', showMenu);
  ipcMain.on('login', openLoginWindow);
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
