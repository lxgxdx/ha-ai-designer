/**
 * Daemon config — env-driven, no defaults that surprise users.
 *
 * Ports are pinned by tools-dev: HA_DAEMON_PORT / HA_WEB_PORT.
 */

export interface DaemonConfig {
  /** Bind address. Always loopback unless explicitly set otherwise. */
  host: string;
  /** HTTP port for /api/* */
  port: number;
  /** Web origin allowed by CORS, e.g. "http://localhost:3000" */
  webOrigin: string;
  /** Data directory — holds SQLite, projects, logs. */
  dataDir: string;
  /** Pretty logs in dev, JSON in production. */
  logPretty: boolean;
}

const env = (key: string, fallback?: string): string | undefined =>
  process.env[key] ?? fallback;

const num = (key: string, fallback: number): number => {
  const raw = env(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (key: string, fallback: boolean): boolean => {
  const raw = env(key);
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
};

export const config: DaemonConfig = {
  host: env('HA_DAEMON_HOST', '127.0.0.1')!,
  port: num('HA_DAEMON_PORT', 7456),
  webOrigin: env('HA_WEB_ORIGIN', `http://localhost:${num('HA_WEB_PORT', 3000)}`)!,
  dataDir: env('HA_DATA_DIR', './data')!,
  logPretty: bool('HA_LOG_PRETTY', process.env.NODE_ENV !== 'production'),
};
