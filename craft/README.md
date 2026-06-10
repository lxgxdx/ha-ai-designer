# Craft

通用 HA 美学工艺 — 跨 design system 都成立的美学规则。

```
craft/
├── ha-spacing.md             # 卡片间距 / 内边距的统一规范
├── ha-color.md               # 颜色使用规则（每屏 ≤ 2 处强调色）
├── ha-card-anti-patterns.md  # 反模式（不要把按钮塞在 sensor 卡片里等）
└── ha-mobile-readability.md  # 移动端可读性（最小可点区域、字号下限）
```

## 与 DESIGN.md 的边界

- **DESIGN.md**：单个品牌的具体决策（"主色 #0F172A、圆角 8"）
- **craft/**：跨品牌成立的原则（"任何卡片内边距 ≥ 12px"、"所有圆角统一"）

`SKILL.md` 通过 `craft.requires: [ha-spacing, ha-color]` 显式声明要哪些 craft 文件，daemon 在拼装 prompt 时按声明注入。

## 当前状态

占位。v0.4 写第一个 `ha-card-anti-patterns.md`。
