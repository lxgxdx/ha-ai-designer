/**
 * /api/health — daemon heartbeat
 */

export interface HealthResponse {
  /** Service identifier, e.g. "ha-ai-designer-daemon" */
  service: string;
  /** ISO 8601 timestamp */
  ts: string;
  /** Daemon semantic version */
  version: string;
  /** Uptime in seconds */
  uptimeSec: number;
  /** Per-subsystem status snapshot */
  subsystems: HealthSubsystem[];
}

export interface HealthSubsystem {
  name: string;
  ok: boolean;
  /** Optional human-readable detail */
  detail?: string;
}
