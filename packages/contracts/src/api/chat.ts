/**
 * Chat / streaming event DTOs.
 *
 * Aligned with open-design's SSE event shape, extended with HA-specific
 * tool-call kinds (ha_list_entities, ha_push_dashboard, etc.).
 */

/** A single SSE event from POST /api/chat. */
export type ChatEvent =
  | { kind: 'message_start'; messageId: string }
  | { kind: 'text_delta'; delta: string }
  | { kind: 'thinking_delta'; delta: string }
  | { kind: 'tool_call'; toolCall: ToolCall }
  | { kind: 'tool_result'; toolCallId: string; result: unknown; isError?: boolean }
  | { kind: 'artifact_update'; artifact: ArtifactRef }
  | { kind: 'message_end'; usage?: TokenUsage }
  | { kind: 'error'; message: string };

/** A tool the LLM may invoke. */
export interface ToolCall {
  id: string;
  /** Tool name, e.g. "ha_list_entities" | "ha_get_dashboard" | "ha_push_dashboard" */
  name: string;
  /** JSON arguments as the model emitted them */
  args: Record<string, unknown>;
}

/** Reference to an artifact on disk. */
export interface ArtifactRef {
  id: string;
  /** File path relative to data/projects/<projectId>/ */
  path: string;
  /** What kind of artifact, e.g. "lovelace-yaml" | "preview-html" */
  kind: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
