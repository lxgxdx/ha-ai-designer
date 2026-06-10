# Design Systems

HA 主题（DESIGN.md）。9-section schema（与 open-design 兼容，仅内容域改为 HA 美学）。

```
design-systems/
├── governance-formal/        # 政务庄重
│   └── DESIGN.md
├── home-minimalist/          # 家居极简
└── dark-glass/               # 暗色玻璃风
```

## DESIGN.md 9-section schema

1. **Visual Theme & Atmosphere** — 整体氛围描述（庄重/温馨/科技）
2. **Color Palette & Roles** — 主色 + 辅色 + 状态色（on/off/error）
3. **Typography Rules** — 字号 / 字重 / 行高 / 中英文字体
4. **Component Stylings** — 卡片圆角 / 阴影 / 内边距
5. **Layout Principles** — 网格列数 / 卡片密度 / 信息层级
6. **Depth & Elevation** — 阴影 / 模糊 / z-index
7. **Do's and Don'ts** — 美学规则（不要霓虹色 / 必备对齐）
8. **Responsive Behavior** — 桌面 / 平板 / 手机三种视口
9. **Agent Prompt Guide** — 给 LLM 看的总结（"选 mushroom 卡片、圆角 12、字号 16…"）

## 当前状态

占位。v0.4 写第一个真实 design system（`governance-formal` 或 `home-minimalist`）。
