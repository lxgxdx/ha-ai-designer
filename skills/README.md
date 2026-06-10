# Skills

HA 场景技能（SKILL.md）。每个子目录一个场景。

```
skills/
├── living-room-dashboard/
│   ├── SKILL.md              # 必填：frontmatter + workflow
│   ├── assets/               # 模板片段（YAML / HTML）
│   └── references/           # 给 LLM 看的知识文件
├── bedroom-night-mode/
├── kitchen-quick-control/
├── governance-status-wall/   # 政务大屏
└── energy-monitor/
```

## SKILL.md 协议（计划中）

仿 open-design 协议，本仓库版本的差异：
- `od.mode` 改为 `ha.mode`，值域是 `dashboard` / `view` / `card`
- `od.preview.type` 改为 `ha.preview.type`，值域是 `lovelace-yaml` / `ha-iframe`
- 显式声明 HA 工具依赖：`ha.tools_required: [ha_list_entities, ha_push_dashboard]`

具体 spec 见 `docs/skills-protocol.md`（v0.4 补全）。

## 当前状态

占位。v0.4 写第一个真实 skill（`living-room-dashboard`）。
