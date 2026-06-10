# Card selection per domain
#
# LLM consults this when deciding which `type:` to write for each entity.
# Default rule: use HA built-in cards unless the user has HACS installed.

## By domain

| Domain | Card type | Notes |
|---|---|---|
| `light` | `tile` | Best for on/off. Built-in. No HACS needed. |
| `switch` | `tile` | Same as light, treat as on/off. |
| `climate` | `thermostat` | Built-in. Shows current + target temp. |
| `media_player` | `media-control` | Built-in. Shows cover art + transport. |
| `vacuum` | `tile` | Built-in. Tap → more-info for controls. |
| `fan` | `tile` | Built-in. |
| `cover` | `tile` | Built-in. |
| `lock` | `tile` | Built-in. |
| `binary_sensor` (door / window / motion) | `tile` | No tap action needed. |
| `sensor` (temperature / humidity / battery) | `sensor` | Compact numeric display. |
| `sensor` (text / other) | `entities` | One entity per row. |
| `weather` | `weather-forecast` | One per location. |
| `update` | `updates` | Aggregated, HA shows them all in one card. |

## When to nest in a container

- 5+ cards of the same domain in one section → wrap in `vertical-stack` of
  `tile` cards. Otherwise keep them flat in the section grid.
- 2+ heterogeneous entities (light + switch + climate) in one section →
  keep flat; the section's grid handles layout.

## HACS cards (only if user has them installed)

| HACS card | When to use | Fallback |
|---|---|---|
| `custom:mushroom-light-card` | Light with brightness / color | `tile` |
| `custom:mushroom-climate-card` | Climate with fan / swing / mode | `thermostat` |
| `custom:mushroom-entity-card` | Generic entity with state + icon | `tile` |
| `custom:mushroom-template-card` | Computed state (e.g. light count) | markdown |
| `custom:mushroom-chips-card` | Tight row of small entity chips | `glance` |
| `custom:button-card` | Per-entity state → color / icon mapping | `tile` (looser) |

**Default posture (v0.4a)**: assume HACS is **not** installed. Use built-in
`tile` / `thermostat` / `sensor` / `weather-forecast`. The orchestrator may
add a `style: 'mushroom'` parameter in a later version that flips to
HACS cards when the user confirms HACS availability.
