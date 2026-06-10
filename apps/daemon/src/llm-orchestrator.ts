/**
 * LLM orchestrator — turn a user brief into a LovelaceConfig.
 *
 * v0.4a scope: non-streaming, single-shot. The LLM gets:
 *   1. system prompt: SKILL.md body + DESIGN.md (if any) + wiki summaries
 *   2. user message: the brief + the live entity list (from HA /api/states)
 *   3. one tool: submit_dashboard(config: LovelaceConfig) — the LLM calls
 *      this when it has a final answer
 *
 * v0.5 will add streaming, comment-mode refinement, and tweak sliders.
 */

import { join, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import yaml from 'js-yaml';
import { chat, ChatMessage } from './llm-client.js';
import { haRequest } from './ha-client.js';
import { logger } from './logger.js';
import type { LovelaceConfig } from '@ha-designer/contracts';

export interface OrchestrateRequest {
  /** The user-written brief, e.g. "做一个全屋概览，深蓝主题". */
  brief: string;
  /** Optional skill name to bind. Defaults to "home-overview-dashboard". */
  skillName?: string;
  /** Optional design system name. Defaults to the first one found. */
  designSystemName?: string;
  /** Whether to pass the live entity list. Default true. */
  includeEntities?: boolean;
}

export interface OrchestrateResult {
  /** The generated dashboard config. */
  config: LovelaceConfig;
  /** YAML representation (for display in the UI). */
  yaml: string;
  /** Brief summary of what the LLM used. */
  meta: {
    skillName: string;
    entitiesIncluded: number;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  /** Warnings produced during validation (e.g. unknown entity_id). */
  warnings: string[];
}

const SYSTEM_PROMPT_PREFIX = `You are the design agent of ha-ai-designer, a local-first tool for
designing Home Assistant Lovelace dashboards. The user types a brief in
natural language; you respond with a complete Lovelace YAML config.

**Output format**: emit the YAML inside a single \`\`\`yaml ... \`\`\` code
block. NO prose before or after. The YAML must be a complete LovelaceConfig
ready to be saved as the default dashboard.

Hard rules:
- ONLY use entity_ids that appear in the live entity list. Never invent.
- Use HA built-in card types unless the user explicitly asks for HACS.
- Prefer the \`sections\` view layout (HA 2024.3+). One view, named "总览" by default.
- Every card must have a \`type\` field.
- The YAML must be valid — loadable by PyYAML / js-yaml.
- Do not truncate. The output may be long; that is fine.
`;

/**
 * Build a compact entity summary for the LLM prompt.
 *
 * v0.4a heuristic: pass the "designable" entities (the ones a user might
 * want to put on a dashboard) and drop the noise. The full 1499-entity
 * payload blew the prompt to 47k tokens on a single brief.
 *
 * Priority:
 *   - light / switch / climate / fan / cover / media_player / vacuum / lock
 *     (the things you actually control)
 *   - binary_sensor (door/window/motion, often surface on dashboards)
 *   - sensor with friendly_name only (a handful, the user-named ones)
 *   - one weather
 *   - aggregates (light.all_lights etc) come first in their group
 */
function summarizeEntities(
  entities: { entity_id: string; state: string; attributes: Record<string, unknown> }[],
): string {
  const CONTROLLABLE = new Set([
    'light', 'switch', 'climate', 'fan', 'cover', 'media_player', 'vacuum', 'lock',
    'input_boolean', 'input_number', 'input_select', 'input_text', 'input_button',
  ]);
  // We don't include `person` in the entity summary by default — names on
  // a shared dashboard are a privacy concern. Users can opt in via a
  // future input parameter.
  const INFO = new Set(['binary_sensor', 'weather']);
  // For sensor: only include the first N with friendly_name, since these are
  // typically the ones the user has named.
  const SENSOR_KEEP = 30;

  const groups = new Map<string, { entity_id: string; state: string; name: string }[]>();
  let sensorKept = 0;
  for (const e of entities) {
    const dot = e.entity_id.indexOf('.');
    const domain = e.entity_id.slice(0, dot);
    const name =
      (typeof e.attributes.friendly_name === 'string' && e.attributes.friendly_name) ||
      '';
    if (domain === 'sensor') {
      if (!name) continue;          // skip unnamed sensors
      if (sensorKept >= SENSOR_KEEP) continue;
      sensorKept++;
    } else if (!CONTROLLABLE.has(domain) && !INFO.has(domain)) {
      continue;
    }
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain)!.push({ entity_id: e.entity_id, state: e.state, name });
  }

  // Sort: aggregates (all_*) first within each group
  const order = [
    'light', 'switch', 'climate', 'fan', 'cover', 'media_player', 'vacuum', 'lock',
    'input_boolean', 'input_number', 'input_select',
    'binary_sensor', 'weather', 'person', 'sensor',
  ];
  const lines: string[] = [];
  for (const d of order) {
    const items = groups.get(d);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => {
      const aAgg = a.entity_id.includes('.all_') || a.entity_id.endsWith('.all') ? -1 : 0;
      const bAgg = b.entity_id.includes('.all_') || b.entity_id.endsWith('.all') ? -1 : 0;
      if (aAgg !== bAgg) return aAgg - bAgg;
      return a.entity_id.localeCompare(b.entity_id);
    });
    lines.push(`# ${d} (${items.length})`);
    for (const e of items) {
      const name = e.name ? `  [${e.name}]` : '';
      lines.push(`  - ${e.entity_id}${name}  state=${e.state}`);
    }
  }
  return lines.join('\n');
}

/**
 * Load a SKILL.md from skills/<name>/SKILL.md. Returns the raw text
 * (frontmatter + body). The LLM sees this as design guidance.
 */
function loadSkillText(skillName: string): string | null {
  const repoRoot = resolve(process.env.HA_REPO_ROOT ?? '.');
  // Try several locations: skills/<name>/SKILL.md, .claude/skills/<name>/SKILL.md
  const candidates = [
    join(repoRoot, 'skills', skillName, 'SKILL.md'),
    join(repoRoot, '.claude', 'skills', skillName, 'SKILL.md'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf8');
    }
  }
  return null;
}

/**
 * Load a DESIGN.md from design-systems/<name>/DESIGN.md.
 * Returns the file body prefixed with a header naming the system.
 */
function loadDesignText(name?: string): string | null {
  const repoRoot = resolve(process.env.HA_REPO_ROOT ?? '.');
  const dir = join(repoRoot, 'design-systems');
  if (!existsSync(dir)) return null;
  let chosenName: string | null = null;
  let body: string | null = null;
  if (name) {
    const p = join(dir, name, 'DESIGN.md');
    if (existsSync(p)) {
      chosenName = name;
      body = readFileSync(p, 'utf8');
    }
  } else {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        const p = join(dir, e.name, 'DESIGN.md');
        if (existsSync(p)) {
          chosenName = e.name;
          body = readFileSync(p, 'utf8');
          break;
        }
      }
    }
  }
  if (!chosenName || body === null) return null;
  return `# Design system: ${chosenName}\n\n${body}`;
}

export async function orchestrate(
  req: OrchestrateRequest,
): Promise<OrchestrateResult> {
  const skillName = req.skillName ?? 'home-overview-dashboard';
  const includeEntities = req.includeEntities ?? true;

  // 1. Load skill + design
  const skillText = loadSkillText(skillName);
  if (!skillText) {
    throw new Error(
      `Skill "${skillName}" not found under skills/ or .claude/skills/`,
    );
  }
  const designResult = loadDesignText(req.designSystemName);
  const designBlock = designResult ?? '';

  // 2. Load live entities (if requested)
  let entitiesBlock = '';
  let entityList: { entity_id: string }[] = [];
  if (includeEntities) {
    const { data } = await haRequest<{ entity_id: string; state: string; attributes: Record<string, unknown> }[]>(
      '/api/states',
    );
    entityList = data ?? [];
    entitiesBlock = summarizeEntities(entityList as { entity_id: string; state: string; attributes: Record<string, unknown> }[]);
  }

  // 3. Compose messages
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT_PREFIX },
  ];
  if (designBlock) {
    messages.push({ role: 'system', content: `## Active DESIGN.md\n\n${designBlock}` });
  }
  messages.push({ role: 'system', content: `## Active SKILL: ${skillName}\n\n${skillText}` });
  if (entitiesBlock) {
    messages.push({
      role: 'system',
      content: `## Live entities (from your HA instance)\n\n${entitiesBlock}\n\nYou MUST only use entity_ids from this list.`,
    });
  }
  messages.push({ role: 'user', content: req.brief });

  // 4. Call LLM (non-streaming, output YAML in content)
  const response = await chat({
    messages,
    temperature: 0.2,
    max_tokens: 16000,
  });

  // 5. Extract YAML from the assistant content
  const choice = response.choices?.[0];
  const content = choice?.message?.content ?? '';
  const yamlText = extractYamlBlock(content);
  if (!yamlText) {
    throw new Error(
      'LLM reply did not contain a ```yaml``` block. First 500 chars:\n' + content.slice(0, 500),
    );
  }

  // 6. Parse YAML → config
  let config: LovelaceConfig;
  try {
    config = yaml.load(yamlText) as LovelaceConfig;
  } catch (e) {
    throw new Error(
      `LLM YAML is not valid: ${(e as Error).message}\n---raw (first 800 chars)---\n${yamlText.slice(0, 800)}`,
    );
  }

  // 6. Validate (entity existence)
  const warnings = validateConfig(config, entityList);

  // 7. Render to YAML (re-serialize with js-yaml for canonical output)
  const yamlOut = renderYaml(config);

  logger.info(
    {
      skillName,
      entities: entityList.length,
      warnings: warnings.length,
      model: response.model,
      outputYamlBytes: yamlOut.length,
    },
    'orchestrate done',
  );

  return {
    config,
    yaml: yamlOut,
    meta: {
      skillName,
      entitiesIncluded: entityList.length,
      model: response.model,
      usage: response.usage,
    },
    warnings,
  };
}

/**
 * Extract the first ```yaml ... ``` fenced block from the LLM reply.
 * Falls back to looking for the first top-level "title:" or "views:" line
 * if no fence is present (some models drop the fence).
 */
function extractYamlBlock(content: string): string | null {
  // 1. Try ```yaml ... ```
  const fenced = content.match(/```(?:yaml|yml)\s*\n([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  // 2. Try ``` ... ```
  const anyFence = content.match(/```\s*\n([\s\S]*?)```/);
  if (anyFence && anyFence[1]) return anyFence[1].trim();
  // 3. Try bare YAML starting with title: or views:
  const bare = content.match(/((?:title|views):[\s\S]*)/);
  if (bare && bare[1]) return bare[1].trim();
  return null;
}

function validateConfig(
  config: LovelaceConfig,
  entities: { entity_id: string }[],
): string[] {
  const warnings: string[] = [];
  const known = new Set(entities.map((e) => e.entity_id));
  const referenced = new Set<string>();
  walkCards(config, (card) => {
    const eid = (card as Record<string, unknown>).entity as string | undefined;
    if (typeof eid === 'string') referenced.add(eid);
    const ents = (card as Record<string, unknown>).entities as unknown[] | undefined;
    if (Array.isArray(ents)) {
      for (const e of ents) {
        if (typeof e === 'string') referenced.add(e);
        else if (e && typeof e === 'object' && typeof (e as { entity?: string }).entity === 'string') {
          referenced.add((e as { entity: string }).entity);
        }
      }
    }
  });
  for (const eid of referenced) {
    if (!known.has(eid)) {
      warnings.push(`Unknown entity_id: ${eid} (no match in HA)`);
    }
  }
  return warnings;
}

function walkCards(node: unknown, visit: (card: unknown) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) walkCards(x, visit);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.type === 'string') {
    visit(obj);
  }
  // Recurse into known container fields, including the new sections layout.
  for (const k of ['cards', 'sections', 'views', 'entities', 'badges', 'grid_options']) {
    if (obj[k] !== undefined) walkCards(obj[k], visit);
  }
}

/**
 * Lenient JSON parse — the LLM sometimes returns truncated or slightly
 * malformed tool-call arguments. We try:
 *   1. JSON.parse as-is
 *   2. if the input is truncated (ends without '}' or ']'), try to find
 *      the longest prefix that parses (greedy backtrack)
 *   3. if that fails, throw with a useful message
 */
function parseJsonLenient(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (e) {
    // Try truncating at the last closing brace
    const lastClose = Math.max(input.lastIndexOf('}'), input.lastIndexOf(']'));
    if (lastClose > 0) {
      const candidate = input.slice(0, lastClose + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        // fall through
      }
    }
    throw new Error(`${(e as Error).message} (truncated at ${lastClose})`);
  }
}

/**
 * Tiny YAML serializer — sufficient for LovelaceConfig (no anchors, no
 * flow style). Hand-rolled to avoid pulling in a dep just for output.
 */
/**
 * Render the final LovelaceConfig to YAML using js-yaml for canonical
 * indentation. Previously we hand-rolled this and it produced visually
 * correct but syntactically confusing output (e.g. `    -     title:`).
 */
function renderYaml(config: LovelaceConfig): string {
  return yaml.dump(config, {
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
}

function renderYamlString(s: string, indent: number): string {
  // If the string contains special chars or looks like a number/bool, quote it.
  if (
    s === '' ||
    /[:#\n]/.test(s) ||
    /^(true|false|null|yes|no|on|off|\d+(\.\d+)?)$/i.test(s) ||
    /^\s|\s$/.test(s)
  ) {
    // Use double quotes, escape backslashes and double quotes
    return JSON.stringify(s);
  }
  // Multi-line: use block scalar
  if (s.includes('\n')) {
    const pad = '  '.repeat(indent + 1);
    return '|\n' + s.split('\n').map((l) => pad + l).join('\n');
  }
  return s;
}
