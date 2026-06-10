---
name: home-overview-dashboard
zh_name: "全屋概览仪表板"
en_name: "Home Overview Dashboard"
description: |
  Build a single Lovelace dashboard that gives the user a one-glance overview
  of the whole home: top-row global shortcuts, then per-area sections with
  lights / switches / sensors / climate, then a footer with system info.
  Use when the brief asks for a "home overview", "总览", "首页", "all areas",
  or any "I want to see everything in one place" dashboard.
triggers:
  - "全屋概览"
  - "总览"
  - "首页"
  - "home overview"
  - "main dashboard"
  - "all areas"
  - "总开关"
  - "first screen"
od:
  mode: dashboard
  platform: ha
  scenario: home
  preview:
    type: lovelace-yaml
    entry: ui-lovelace.yaml
  design_system:
    requires: true
    sections: [color, typography, layout, components]
  craft:
    requires: [spacing, density, anti-patterns]
  inputs:
    - name: areas
      type: enum
      multi: true
      values: [auto, living_room, dining_room, master_bedroom, parents_room, kids_room, study, hallway, kitchen, balcony, all]
      default: auto
      help: "auto = infer from entity_id prefixes; explicit list = only those areas"
    - name: include_climate
      type: boolean
      default: true
    - name: include_media
      type: boolean
      default: false
    - name: include_sensors
      type: boolean
      default: true
    - name: style
      type: enum
      values: [minimal, dashboard, info-dense]
      default: dashboard
  parameters:
    - name: section_spacing
      type: spacing
      default: 32
      range: [16, 80]
    - name: cards_per_row
      type: number
      default: 4
      range: [2, 8]
    - name: show_unavailable
      type: boolean
      default: false
  outputs:
    primary: ui-lovelace.yaml
  capabilities_required:
    - file_write
    - structured_output
    - ha_list_entities
    - ha_get_dashboard
    - ha_push_dashboard
---

# Home Overview Dashboard Skill

Generate a single Lovelace dashboard that summarizes the entire home. The
output is a complete `LovelaceConfig` object (not a diff) intended to be
pushed via the `lovelace/config/save` WebSocket command.

## Workflow

1. **Read the active DESIGN.md** (injected above). Color, typography, layout
   tokens all come from it. Do not invent new tokens.

2. **Resolve the active HA instance.** Call `ha_list_entities` to enumerate
   all entities. Group by `entity_id` prefix (the user names entities in
   pinyin — see [references/entity-id-area-inference.md](references/entity-id-area-inference.md)).
   Domains of interest: `light`, `switch`, `climate`, `media_player`,
   `binary_sensor`, `sensor`, `vacuum`, `fan`, `cover`. Skip everything else
   unless `include_*` inputs force it on.

3. **Build the section list.** If `areas` input is `auto`, derive the
   ordered list from entity_id prefixes that have ≥ 2 entities; if a prefix
   has only 1 entity, fold it into a single "其他" section at the end. Sort
   the result by traffic frequency — `ke_ting` (living room) and
   `can_ting` (dining) first, then bedrooms, then service areas.

4. **Lay out the dashboard as a `sections` view** (2024.3+ — preferred over
   masonry). Use `assets/base.yaml` as the skeleton, then populate each
   section with cards from `assets/room-block.yaml`. Top section is a
   horizontal "全屋快捷" row (all-lights, all-switches, presence, climate
   average). Bottom is a footer with sensors and updates.

5. **Per-area section content** (see [references/card-selection.md](references/card-selection.md)):

   - **Lights**: prefer HA built-in `tile` per light when count ≤ 4, else
     nest in `vertical-stack` of `tile` cards. Set `grid_options.columns`
     so the section spans 2 or 3 columns based on light count.
   - **Switches**: same as lights, one `tile` per switch.
   - **Climate** (if `include_climate`): use built-in `thermostat` card.
   - **Media** (if `include_media`): use built-in `media-control` card.
   - **Sensors** (if `include_sensors`): use built-in `sensor` card for
     temperature / humidity, one card per sensor. Cap at 6 per section.

   **For section titles in a sections view, use `type: heading`** with
   a `heading:` field. There is no card type called `section` — that
   will fail to render in HA.

6. **Self-check** before emitting:

   - Every `entity_id` referenced must exist in the entities list — no
     guessing, no inventing.
   - No `light.*` entity is duplicated across cards.
   - `light.all_lights` (if present) is shown ONCE in the top "全屋快捷"
     section, never in a per-area block.
   - Entities with `state == 'unavailable'` are dropped unless
     `show_unavailable` is true.
   - Every section is a `grid` (not bare card list) so the dashboard reads
     as one cohesive surface.
   - Accent color (from DESIGN.md) appears ≤ 2 times per screen.

7. **Emit a single YAML object** matching the `LovelaceConfig` schema (see
   `packages/contracts/src/api/ha.ts`). The orchestrator will validate and
   parse it with js-yaml.

## HARD CONSTRAINT — Card type whitelist

The output YAML **MUST** only use these card `type:` values. Any other
type (e.g. `type: light`, `type: switch`, `type: section`, `type: cover`)
will fail to render in HA. Domain names (light, switch, climate, cover)
are **NOT** valid card types — they are the entity's domain prefix.

| Card `type` | Use for |
|---|---|
| `tile` | Any single entity (light, switch, sensor, vacuum, cover, fan, lock, person, …) |
| `entities` | A list of entities, vertical |
| `glance` | A list of entities, horizontal icons |
| `button` | A pressable button (use `tile` instead for modern dashboards) |
| `vertical-stack` | Container — stack cards vertically |
| `horizontal-stack` | Container — arrange cards horizontally |
| `grid` | Container — N-column grid |
| `conditional` | Container — show inner cards only if condition matches |
| `markdown` | Free-form text / notes |
| `heading` | **Section title** in a sections view (`heading: "客厅"`) |
| `sensor` | Single sensor numeric display |
| `thermostat` | Climate / AC |
| `weather-forecast` | Weather |
| `history-graph` | Time-series line chart |
| `statistics-graph` | Long-term stat chart |
| `media-control` | Media player |
| `map` | Map |
| `calendar` | Calendar |
| `picture` / `picture-entity` / `picture-glance` | Image-based cards |
| `picture-elements` | Image + state-badge / state-icon overlays |
| `updates` | All available updates |
| `iframe` | Embedded URL |

If a feature seems to require a domain-named type (`type: light`), use
`type: tile` with the entity_id of a light instead. HA's `tile` card
auto-detects the entity domain and renders the right control.

## Output contract

```json
{
  "title": "<from inputs.style + 概览>",
  "views": [
    {
      "title": "总览",
      "path": "home",
      "type": "sections",
      "max_columns": <cards_per_row>,
      "sections": [
        { "type": "grid", "cards": [ /* 全屋快捷 row */ ] },
        { "type": "grid", "cards": [ /* per-area sections */ ] },
        { "type": "grid", "cards": [ /* footer */ ] }
      ]
    }
  ]
}
```

## Failure modes the LLM must avoid

- ❌ Hallucinating entity_ids — if not in `ha_list_entities`, drop it.
- ❌ Putting `light.all_lights` inside a per-area block.
- ❌ Using `mushroom-*` types when the user hasn't installed HACS Mushroom.
  Default to built-in `tile` and let the user opt into HACS cards later.
- ❌ Blowing past the "≤ 2 accent uses per screen" rule.
- ❌ Mixing `masonry` (`cards: [...]`) and `sections` (`sections: [...]`)
  in the same view.

## See Also

- [entity-id-area-inference.md](references/entity-id-area-inference.md) — how
  to map pinyin entity_ids to area sections.
- [card-selection.md](references/card-selection.md) — which built-in card
  to use per domain.
- [../../hha-knowledge/wiki/cards/built-in-cards-overview.md](../../hha-knowledge/wiki/cards/built-in-cards-overview.md)
  — full list of 51 built-in cards.
