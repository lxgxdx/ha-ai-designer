/**
 * Home Assistant adapter DTOs.
 *
 * These mirror the shape of HA's REST/WS responses but are intentionally
 * minimal — only the fields the designer tool needs.
 *
 * References:
 *   - https://developers.home-assistant.io/docs/api/rest/
 *   - https://developers.home-assistant.io/docs/api/websocket/
 */

/** Connection config the user supplies once at first run. */
export interface HaConnectionConfig {
  /** Base URL, e.g. "http://homeassistant.local:8123" */
  baseUrl: string;
  /** Long-Lived Access Token from HA profile page */
  token: string;
}

/** Probe result — daemon reached HA successfully. */
export interface HaPingResponse {
  ok: boolean;
  /** HA version string returned by /api/ */
  haVersion?: string;
  /** Friendly diagnostic message on failure */
  message?: string;
}

/** Minimal entity projection — what the designer UI actually uses. */
export interface HaEntity {
  entity_id: string;
  state: string;
  /** friendly_name, unit_of_measurement, device_class, etc. */
  attributes: Record<string, unknown>;
  /** ISO 8601 timestamp of last state change */
  last_changed: string;
  /** ISO 8601 timestamp of last update */
  last_updated: string;
}

export interface HaListEntitiesRequest {
  /** Optional domain filter, e.g. "light" | "switch" | "sensor" */
  domain?: string;
  /** Optional area name substring match against `attributes.area` */
  area?: string;
  /** Substring match against entity_id or friendly_name */
  q?: string;
}

export interface HaListEntitiesResponse {
  entities: HaEntity[];
  /** Total before paging — kept for future use, currently unused */
  total: number;
}

/** Lovelace dashboard storage mode. */
export type LovelaceMode = 'storage' | 'yaml';

/** Result of fetching a dashboard's current config. */
export interface HaGetDashboardResponse {
  urlPath: string;
  mode: LovelaceMode;
  /** YAML string (yaml mode) or null (storage mode returns config via separate WS call) */
  yaml: string | null;
  /** Parsed config object when available (storage mode from /api/lovelace/config) */
  config: LovelaceConfig | null;
}

/**
 * LovelaceConfig is intentionally `unknown` for now — the full schema
 * is large (200+ card types). We will model it incrementally:
 *   - start with `title`, `views`, each view with `title` + `cards` array
 *   - add per-card `type` discriminated unions as we add Skill coverage
 *
 * For v0.1 this is a black box; the LLM will be given the HA docs
 * + this type as its only structural anchor.
 */
export type LovelaceConfig = {
  title?: string;
  views?: LovelaceView[];
  [k: string]: unknown;
};

export interface LovelaceView {
  title?: string;
  path?: string;
  icon?: string;
  cards?: LovelaceCard[];
  [k: string]: unknown;
}

export interface LovelaceCard {
  type: string;
  [k: string]: unknown;
}

export interface HaPushDashboardRequest {
  urlPath: string;
  /** Push the YAML form (yaml mode) or structured config (storage mode) */
  yaml?: string;
  config?: LovelaceConfig;
  /** When true, daemon writes to a sibling preview dashboard first */
  dryRun?: boolean;
}

export interface HaPushDashboardResponse {
  ok: boolean;
  /** Saved version (storage mode only, from /api/lovelace/config) */
  version?: number;
  /** Diagnostic on failure */
  message?: string;
  /** When dryRun, the effective preview URL the iframe should load */
  previewUrl?: string;
}
