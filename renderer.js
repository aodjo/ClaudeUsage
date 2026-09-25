const GROUP_LABELS = { session: '5시간', weekly: '주간' }; /** Display names for the limit groups returned by the API. */
const TICK_MS = 30_000; /** How often reset countdowns are re-rendered between fetches, in milliseconds. */

const card = document.querySelector('.card'); /** Widget container whose height sizes the window. */
const rowsEl = document.getElementById('rows'); /** Container for the per-limit rows. */
const errorEl = document.getElementById('error'); /** Footer line showing the latest error. */
const updatedEl = document.getElementById('updated'); /** Footer line showing when data was last fetched. */
const refreshBtn = document.getElementById('refresh'); /** Header button that triggers an immediate refresh. */

let latest = null; /** Most recent payload from the main process, re-rendered on every tick. */

/**
 * Builds the display name for an entry of the API's `limits[]` array.
 *
 * The group ("session", "weekly") gives the base label. When the limit is scoped to a
 * model or surface, that name is appended. Unknown groups fall back to the raw `kind`.
 * The `surface` scope may be a string or an object, so both shapes are accepted.
 *
 * @param {Object} limit - One element of `limits[]` from the usage response.
 * @returns {string} Label such as "5시간", "주간" or "주간 · Fable".
 *
 * @example
 * limitLabel({ kind: 'weekly_scoped', group: 'weekly', scope: { model: { display_name: 'Fable' } } }); // '주간 · Fable'
 */
function limitLabel(limit) {
  const base = GROUP_LABELS[limit.group] ?? limit.kind;
  const scope = limit.scope ?? {};
  const name = scope.model?.display_name ?? scope.surface?.display_name
    ?? (typeof scope.surface === 'string' ? scope.surface : null);
  return name ? `${base} · ${name}` : base;
}

/**
 * Converts a usage response into display rows.
 *
 * Uses the `limits[]` array when present, because it lists every active limit, including
 * model-scoped ones. Responses without it fall back to the `five_hour`, `seven_day`,
 * `seven_day_opus` and `seven_day_sonnet` fields, skipping any that are null. Each row
 * has a display `label`, a `percent` from 0 to 100, the ISO 8601 `resetsAt` time (or null)
 * and, when the API provides it, a `severity` such as "normal" or "critical".
 *
 * @param {Object} data - Parsed body of the usage endpoint.
 * @returns {Array<{label: string, percent: number, resetsAt: ?string, severity?: string}>}
 *   Rows in the order the API lists them.
 *
 * @example
 * toRows(data)[0]; // { label: '5시간', percent: 8, resetsAt: '2026-09-25T12:49:59Z', severity: 'normal' }
 */
function toRows(data) {
  if (Array.isArray(data.limits) && data.limits.length) {
    return data.limits.map((l) => ({
      label: limitLabel(l),
      percent: l.percent,
      resetsAt: l.resets_at,
      severity: l.severity,
    }));
  }
  return [
    ['five_hour', '5시간'],
    ['seven_day', '주간'],
    ['seven_day_opus', '주간 · Opus'],
    ['seven_day_sonnet', '주간 · Sonnet'],
  ]
    .filter(([key]) => data[key])
    .map(([key, label]) => ({ label, percent: data[key].utilization, resetsAt: data[key].resets_at }));
}

/**
 * Classifies how close a limit is to being exhausted.
 *
 * A "critical" severity from the API or 90% and above is "crit". 75% and above is "warn".
 * Anything lower is "ok". The result is used as a CSS class that colors the bar.
 *
 * @param {{percent: number, severity?: string}} row - A row from `toRows`.
 * @returns {'ok'|'warn'|'crit'} The alert level.
 *
 * @example
 * level({ percent: 80 }); // 'warn'
 */
function level({ percent, severity }) {
  if (severity === 'critical' || percent >= 90) return 'crit';
  if (percent >= 75) return 'warn';
  return 'ok';
}

/**
 * Formats the time left until a reset as short Korean text.
 *
 * Shows days and hours when more than a day is left, hours and minutes when more than an
 * hour is left, and minutes otherwise. Times in the past are shown as "0분 후".
 *
 * @param {?string} iso - ISO 8601 reset time.
 * @returns {string} Text such as "2시간 43분 후", or an empty string when `iso` is empty.
 *
 * @example
 * untilText(new Date(Date.now() + 163 * 60_000).toISOString()); // '2시간 43분 후'
 */
function untilText(iso) {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) return `${d}일 ${h}시간 후`;
  if (h) return `${h}시간 ${m}분 후`;
  return `${m}분 후`;
}

/**
 * Creates a DOM element with an optional class and text.
 *
 * Text is set through `textContent`, so values from the API are never parsed as HTML.
 *
 * @param {string} tag - Tag name of the element.
 * @param {string} [className] - Class attribute to set.
 * @param {?string} [text] - Text content to set.
 * @returns {HTMLElement} The new element.
 *
 * @example
 * el('span', 'pct', '8%').outerHTML; // '<span class="pct">8%</span>'
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Builds the DOM for one usage limit.
 *
 * The row shows the label, the time left until reset, and the rounded percentage above a
 * progress bar clamped to 0–100%. Hovering the countdown shows the exact local reset time.
 *
 * @param {{label: string, percent: number, resetsAt: ?string, severity?: string}} row - A row
 *   from `toRows`.
 * @returns {HTMLElement} The row element.
 *
 * @example
 * rowsEl.append(renderRow({ label: '5시간', percent: 8, resetsAt: null }));
 */
function renderRow(row) {
  const percent = Math.round(row.percent ?? 0);
  const wrap = el('div', `row ${level(row)}`);

  const line = el('div', 'line');
  line.append(el('span', 'label', row.label));
  const reset = el('span', 'reset', untilText(row.resetsAt));
  if (row.resetsAt) reset.title = `${new Date(row.resetsAt).toLocaleString()} 초기화`;
  line.append(reset, el('span', 'pct', `${percent}%`));

  const bar = el('div', 'bar');
  const fill = el('div', 'fill');
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  bar.append(fill);

  wrap.append(line, bar);
  return wrap;
}

/**
 * Redraws the widget from the latest payload.
 *
 * Replaces all rows, shows or clears the error line, and updates the "last updated" time.
 * When a fetch fails after an earlier success, the previous rows stay visible alongside
 * the error. Does nothing before the first payload arrives.
 *
 * @returns {void}
 *
 * @example
 * setInterval(render, TICK_MS);
 */
function render() {
  if (!latest) return;
  const { data, fetchedAt, error } = latest;

  rowsEl.replaceChildren(...(data ? toRows(data).map(renderRow) : []));
  errorEl.textContent = error ?? '';
  updatedEl.textContent = fetchedAt
    ? `${new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 업데이트`
    : '';
}

/**
 * Stores a payload from the main process and redraws the widget.
 *
 * Also stops the refresh button's spinning animation.
 *
 * @param {{data?: Object, fetchedAt?: number, error: ?string}} payload - Latest usage state.
 * @returns {void}
 *
 * @example
 * window.usage.onUpdate(handleUpdate);
 */
function handleUpdate(payload) {
  latest = payload;
  refreshBtn.classList.remove('spin');
  render();
}

/**
 * Starts an immediate refresh from the header button.
 *
 * Spins the button until the next update arrives.
 *
 * @returns {void}
 *
 * @example
 * refreshBtn.addEventListener('click', handleRefreshClick);
 */
function handleRefreshClick() {
  refreshBtn.classList.add('spin');
  window.usage.refresh();
}

/**
 * Shows the native context menu instead of the browser's.
 *
 * @param {MouseEvent} event - The `contextmenu` event.
 * @returns {void}
 *
 * @example
 * window.addEventListener('contextmenu', handleContextMenu);
 */
function handleContextMenu(event) {
  event.preventDefault();
  window.usage.showMenu();
}

/**
 * Resizes the window to match the card's current height.
 *
 * Runs whenever the card changes size, for example when a limit row or an error line
 * appears or disappears.
 *
 * @returns {void}
 *
 * @example
 * new ResizeObserver(fitWindow).observe(card);
 */
function fitWindow() {
  window.usage.resize(card.getBoundingClientRect().height);
}

window.usage.onUpdate(handleUpdate);
refreshBtn.addEventListener('click', handleRefreshClick);
window.addEventListener('contextmenu', handleContextMenu);
new ResizeObserver(fitWindow).observe(card);
setInterval(render, TICK_MS);
