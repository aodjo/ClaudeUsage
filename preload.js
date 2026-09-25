const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usage', {
  /**
   * Subscribes to usage updates from the main process.
   *
   * The callback runs after every poll, including failed ones. It receives the last
   * successful data, if there is any, together with the latest error message.
   *
   * @param {function({data?: Object, fetchedAt?: number, error: ?string}): void} callback - Called with each update.
   * @returns {void}
   *
   * @example
   * window.usage.onUpdate(({ data, error }) => console.log(error ?? data.five_hour.utilization)); // 8
   */
  onUpdate: (callback) => ipcRenderer.on('usage', (_e, payload) => callback(payload)),

  /**
   * Asks the main process to fetch usage immediately.
   *
   * The request is ignored if a fetch is already in progress. The result arrives through
   * the `onUpdate` callback.
   *
   * @returns {void}
   *
   * @example
   * window.usage.refresh();
   */
  refresh: () => ipcRenderer.send('refresh'),

  /**
   * Opens the widget's native context menu.
   *
   * @returns {void}
   *
   * @example
   * window.addEventListener('contextmenu', () => window.usage.showMenu());
   */
  showMenu: () => ipcRenderer.send('menu'),

  /**
   * Resizes the window to fit the widget.
   *
   * Only the height changes; the width is fixed by the main process.
   *
   * @param {number} height - Height of the widget card in CSS pixels.
   * @returns {void}
   *
   * @example
   * window.usage.resize(163);
   */
  resize: (height) => ipcRenderer.send('resize', height),
});
