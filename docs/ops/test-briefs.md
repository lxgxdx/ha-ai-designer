# A 任务 — 测试 brief 与预期响应

> 这两份 brief 用于 v0.1.20 add-on 端到端 smoke。**先跑 A1 (稳)**,A2 (有 entity 依赖) 可选对照。

---

## 关键约束(LLM 可能踩的坑)

- LLM **必须** 输出 ```yaml ... ``` 块。orchestrator 用正则提取第一个 fenced block。
- 输出会被 `js-yaml` 解析,语法错直接 502。
- entity_id 必须真实存在于 HA(否则进 `warnings[]`)。**A1 不引用 entity,完全回避这层风险。**
- LLM 偶尔会幻觉、pinyin entity_id 习惯容易拼错。
- orchestrator 把 1499 实体摘要到 ~几十个可控的(aggregates 优先、named sensor 限 30)。无关 sensor 全部丢弃,所以 brief 里写"所有 sensor" 可能指代不全。

---

## A1 — 极简稳过版(主推,先跑这个)

**brief** (在 web UI / ChatPane 的输入框里粘这个):

```
做一个最小化的首页。只用一个视图,标题"总览",里面放一个 markdown
卡片,内容写"Hello from ha-ai-designer, smoke test 成功"。

不需要引用任何 entity。
```

**预期响应**(在 web UI 的对话气泡里应该看到一段 markdown 渲染的 YAML 代码块):

````markdown
```yaml
title: 极简首页
views:
  - title: 总览
    path: home
    cards:
      - type: markdown
        content: |
          Hello from ha-ai-designer, smoke test 成功
```
````

**判定标准**:
- ✅ chat 200 + 返回 `{ ok: true, config, yaml, meta, warnings }`
- ✅ `warnings` 数组**空** (A1 不引用 entity,所以没有 "找不到 entity_id" 警告)
- ✅ `meta.entitiesIncluded` 是个数字(说明 orchestrate 走完了)
- ✅ `yaml` 字段能被 `python -c "import yaml; yaml.safe_load(open(...))"` 解析
- ✅ 推 preview 后,HA 仪表板出现一个 markdown 卡片,内容是 "Hello from ha-ai-designer, smoke test 成功"
- ✅ `/data/backups/lovelace/<ts>.json` 出现新文件,内容是刚才的 LovelaceConfig

---

## A2 — 真业务版(可选,验证 entity 校验链)

**前置检查**(在 web UI 的 LLM 面板或 HA Configuration 里看不到 entity?可以从浏览器 devtools 调 daemon):

```bash
# 容器内(或 host 上)列 binary_sensor
curl -sS http://127.0.0.1:7456/api/ha/entities?domain=binary_sensor
```

如果返回 `entities: []` 说明 HA 没 binary_sensor,改用 `?domain=light`。

**brief**:

```
做一个最简的总览页。顶部一个 glance 卡片,横向展示所有
binary_sensor 实体(门、窗、人体感应等);下面一个 markdown
卡片写注释"由 ha-ai-designer 自动生成"。

只用一个视图,标题"总览"。
```

**预期响应**(YAML 块,大致长这样):

````markdown
```yaml
title: 简版总览
views:
  - title: 总览
    path: home
    cards:
      - type: glance
        entities:
          - binary_sensor.door_xxx
          - binary_sensor.window_yyy
          - binary_sensor.motion_zzz
      - type: markdown
        content: |
          由 ha-ai-designer 自动生成
```
````

**判定标准**:
- ✅ chat 200 + 返回 yaml 块
- ⚠️ `warnings[]` **可能有**(LLM 偶尔幻觉 entity_id),具体看返回内容。如果 warnings 非空但 yaml 仍能被 push,**说明业务流 OK,只是 entity 校验抓到问题**。
- ✅ HA 仪表板出现 glance 卡片 + markdown 卡片,glance 显示实际的 binary_sensor 状态图标
- ✅ 备份文件出现

---

## 万一 LLM 不输出 yaml 块

orchestrator 报错信息会包含前 500 字符的 LLM 原样回复。常见原因:
- MiniMax 在 940 token cap 触发了截断(但 LLM 输出是 16k max_tokens 应该不会触底)
- 温度/系统 prompt 不匹配模型习惯

如果 yaml 块正常但 push preview 失败:
- 看 `/data/logs/daemon.log` 末尾的 `→ HA dashboard push — proceeding after user confirmation` 行
- 看 `WebSocket` 握手错误(SUPERVISOR_TOKEN 失效?)
- 看 HA supervisor log 是否有 `lovelace/config/save` 拒绝记录

---

## 拿数据回来给我

跑完把以下贴回:
1. smoke 脚本输出(PASS/FAIL 汇总)
2. `/data/logs/{run,daemon,web}.log` 末尾 100 行(用 `docker exec addon_<id> tail -100 /data/logs/daemon.log`)
3. chat 响应的 yaml 块(从 web UI 复制)
4. preview push 后的 response(200 / 502 / 其他)
5. `ls -la /data/backups/lovelace/`(看新快照)
6. HA 仪表板的截图(看新卡有没有出现)
