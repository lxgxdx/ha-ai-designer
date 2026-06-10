# Entity-id → Area inference (pinyin)
#
# The user's HA instance does NOT set `attributes.area` on entities
# (verified: 48/48 lights have no area). Areas must be inferred from the
# entity_id prefix.
#
# This document defines the pinyin prefix → area mapping. Add new entries
# as new rooms appear.

## Pinyin prefix table

| Prefix (lowercased) | Room (zh) | Room (en) | Default sort order |
|---|---|---|---|
| `ke_ting` | 客厅 | living_room | 1 |
| `can_ting` | 餐厅 | dining_room | 2 |
| `chu_fang` / `zhong_chu` / `xi_chu` | 厨房 | kitchen | 3 |
| `zhu_wo` | 主卧 | master_bedroom | 4 |
| `er_tong_fang` / `hai_zi_fang` | 儿童房 | kids_room | 5 |
| `fu_mu_fang` / `laoren_fang` | 父母房 | parents_room | 6 |
| `shu_fang` | 书房 | study | 7 |
| `yi_mao_jian` | 衣帽间 | cloakroom | 8 |
| `xuan_guan` | 玄关 | entryway | 9 |
| `zou_lang` / `guo_dao` | 走廊 | hallway | 10 |
| `wei_sheng_jian` | 卫生间 | bathroom | (fold into host room) |
| `yang_tai` / `bei_yang_tai` / `zhu_yang_tai` | 阳台 | balcony | 11 |
| `yuan_ting` | 庭院 | yard | 12 |

## Rules

1. **The first underscore-separated token is the area prefix** (unless the
   entity_id starts with a known system prefix like `light.all_lights`).
2. **`light.all_lights` and similar `*.all_*` aggregates** are NOT area-
   bound — they go to the top "全屋快捷" row, never to a per-area section.
3. **Sub-rooms**: `fu_mu_fang_wei_sheng_jian_deng` (父母房卫生间灯) belongs
   in the `fu_mu_fang` section, not its own bathroom section. Only create
   a sub-section if the sub-room has ≥ 2 standalone entities.
4. **Single-entity prefixes**: if a prefix yields only 1 entity, fold it
   into a `其他` section at the end of the dashboard.
5. **Unknown prefixes**: also fold into `其他` — never invent a room name.

## Examples (from user's HA 2026-06)

```
ke_ting_bi_deng_deng_dai_left   → 客厅 (壁灯带 left)
fu_mu_fang_tong_deng_zhu_deng_left → 父母房 (筒灯主灯 left)
zhu_wo_xi_shu_tai_tong_deng      → 主卧 (洗漱台筒灯)
zou_lang_deng_left                → 走廊 (灯 left)
light.all_lights                  → 全屋快捷 (not a room)
light.aqara_night_light           → 其他 (unknown prefix)
```
