/**
 * Electron preload — v0.5.0.
 *
 * Runs in an isolated context (contextIsolation: true) with
 * sandbox: true. Exposes a minimal, typed API surface to the
 * renderer via contextBridge. Currently just `app.version`
 * (for "About" dialog) and `app.openExternal` (for opening
 * links).
 *
 * Anything the renderer needs that isn't already in the web
 * (HTTP fetch to the local daemon via the same-origin proxy
 * is sufficient for 99% of cases) should go through this
 * bridge — never enable nodeIntegration.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('haAiDesigner', {
  version: '0.5.0-alpha.1',
  onDaemonExit(callback: (code: number | null) => void): () => void {
    const handler = (_: unknown, code: number | null) => callback(code);
    ipcRenderer.on('daemon-exit', handler);
    return () => ipcRenderer.removeListener('daemon-exit', handler);
  },
});
