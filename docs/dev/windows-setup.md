# Windows 本地开发环境搭建（v0.5.0+）

> **绝大多数用户不需要这个** — 直接从 GitHub Releases 下载 `HA.AI.Designer-Setup-x.y.z.exe`，双击装。开发 .exe 的人也要先有一个能跑的 dev 环境。
>
> 这份文档给开发者的：从零开始让 `pnpm tools-dev run web` 在你本机能跑起来。

## 零、TL;DR（6 步）

```bash
# 1. 装 nvm-windows（多 Node 版本管理）
winget install CoreyButler.NVMforWindows
# 关掉旧终端，开新的

# 2. 装 Node 22 LTS（必须 22，不要 24，不要 20）
nvm install 22
nvm use 22
node --version   # v22.x.x

# 3. 装 pnpm（如果还没装）
npm install -g pnpm@10.33.2

# 4. 拉代码
git clone https://github.com/lxgxdx/ha-ai-designer.git
cd ha-ai-designer

# 5. 装依赖（Node 22 有 better-sqlite3 预编译，秒装）
pnpm install

# 6. 起服务
pnpm tools-dev run web
# 浏览器开 http://localhost:3000
# 所有 daemon + web 日志在终端里实时打
```

`Ctrl-C` 退出。

## 一、为什么必须 Node 22

daemon 用 `better-sqlite3@11.10.0` 做 RAG 向量存储（sqlite-vec 后端）。在 Windows 上，这个版本有 **Node 18-22** 的 win32-x64 预编译二进制。**Node 24 没有预编译**，会触发 `node-gyp` 源码编译——编译需要：

- Visual Studio Build Tools 2017+（带 "Desktop development with C++" workload，5GB）
- Python 3
- 大约 10-15 分钟的首次构建时间

`docs/dev/` 目录下不再推荐这条路——太重，对 Windows 用户不友好。**直接装 Node 22** 跳过所有这些。

Electron 35+ 自带 Node 22.15，所以 dev 模式编译出来的 `.node` 二进制在 packaged .exe 里也能跑（ABI 兼容）。

## 二、详细步骤

### 2.1 装 nvm-windows

`nvm-windows` 让你在机器上同时装多个 Node 版本，用 `nvm use 22` 切到 22，用 `nvm use 24` 切回 24。

```bash
# 推荐用 winget（Win 11 自带）
winget install CoreyButler.NVMforWindows
```

> 装完**关掉所有终端窗口**，开新的 PowerShell 或 cmd。`nvm` 命令在老终端里不识别。
>
> 如果 winget 装不上（公司机器策略），从 GitHub Release 装：
> https://github.com/coreybutler/nvm-windows/releases
> 下载 `nvm-setup.exe`，一路 Next。

### 2.2 装 Node 22

```bash
nvm install 22
nvm use 22
node --version   # 应该显示 v22.x.x
```

切到项目目录后，再跑一次 `nvm use 22`，确保当前 shell 是 Node 22。

`.nvmrc` 文件会自动被很多 IDE（VS Code 等）识别，**进入项目目录自动切**到 `.nvmrc` 里指定的版本。仓库根有个 `.nvmrc`，但里面只是 `22`：

```bash
cat .nvmrc   # 22
```

### 2.3 装 pnpm

如果之前没装 pnpm：

```bash
npm install -g pnpm@10.33.2
pnpm --version   # 10.33.2
```

> **Windows 上不要用 `corepack enable`** — 它有 EPERM 权限 bug，会失败。直接用 `npm install -g pnpm@10.33.2`。
>
> 已经装了 pnpm 但版本不对？`npm install -g pnpm@10.33.2` 覆盖。

### 2.4 拉代码

```bash
git clone https://github.com/lxgxdx/ha-ai-designer.git
cd ha-ai-designer
```

如果你之前 clone 过：

```bash
cd ha-ai-designer
git pull
```

### 2.5 装依赖

```bash
pnpm install
```

**第一次跑大概 60-90 秒**——`better-sqlite3` 下载 win32-x64 Node 22 预编译二进制（几 MB，秒下）。如果报 `prebuild-install warn No prebuilt binaries found` 然后 `gyp ERR! find VS`，说明 Node 版本错了，回 2.2。

### 2.6 跑 dev 服务

```bash
pnpm tools-dev run web
```

这会同时起两个进程：

- `apps/daemon` — 监听 7456，所有 `/api/*`、HA 适配、LLM 调用
- `apps/web` — 监听 3000，Next.js 前端

输出长这样：

```
[daemon] ...
[web]    ready on http://localhost:3000
```

打开 <http://localhost:3000>，第一次会跳到 `/setup` wizard，按 4 步填 HA + LLM 配置。

**所有日志（pino INFO 级带时间戳）实时打在你的终端**。要看更细的：

```bash
HA_LOG_LEVEL=debug pnpm tools-dev run web
```

### 2.7 其他 dev 工具

```bash
pnpm typecheck           # 仓库级 tsc --noEmit
pnpm build               # 仓库级 build（daemon tsc + web next build）

# 桌面 .exe 开发（要先另起终端跑 tools-dev run web）
pnpm desktop:dev         # 编译 Electron main + preload，起 Electron 窗口
                         # 窗口里加载 http://127.0.0.1:3000
```

## 三、调试打包后的 .exe（不重新打包）

如果用户已经装了 alpha.x 的 .exe，遇到问题想看真实日志，**不用重新打包**：

### 3.1 日志文件位置

```
%APPDATA%\ha-ai-designer\logs\daemon.log
%APPDATA%\ha-ai-designer\logs\web.log
```

实际路径（你的机器）：

```
C:\Users\ROG\AppData\Roaming\ha-ai-designer\logs\daemon.log
C:\Users\ROG\AppData\Roaming\ha-ai-designer\logs\web.log
```

> **alpha.5 起**：Electron 启动时会先在日志文件里写一行 `=== ISO 时间 HA AI Designer startup ===` header，哪怕 daemon 秒退，日志文件也是**存在且非空**的。

### 3.2 直接跑 packaged daemon（不经过 Electron）

如果日志文件还是空的或者没有 stack trace，可以绕过 Electron，直接用 Node 跑 packaged 的 daemon：

```bash
# 找到 packaged daemon 的位置
"%LOCALAPPDATA%\Programs\HA AI Designer\HA AI Designer.exe" --no-sandbox
# 不行，这个是 Electron GUI

# 直接 node 调
cd "%LOCALAPPDATA%\Programs\HA AI Designer\resources\daemon\dist"
node server.js
```

这会**直接打印完整 pino 日志到当前终端**。`Ctrl-C` 退出。

### 3.3 失败弹窗直接看 stderr

alpha.5 起，**启动失败时 error dialog 里有 daemon / web 进程的最后 80 行输出**。报错弹窗不再只是 "30s timeout" 那个时间错——会包含 daemon 的真实 stack trace，比如：

```
Error: Could not locate the bindings file. Tried:
  → ...\node_modules\better-sqlite3\build\Release\better_sqlite3.node
  ...
```

把这段贴给开发者就能定位。

## 四、常见问题

### Q1: `pnpm install` 报 `prebuild-install warn No prebuilt binaries found` 然后 `gyp ERR! find VS`

**Node 版本错了**。检查：

```bash
node --version   # 必须是 v22.x
```

如果是 24 或 20，切回 22：

```bash
nvm use 22
```

### Q2: 端口被占用

```
EADDRINUSE 127.0.0.1:7456
```

杀掉旧进程：

```bash
# 找占 7456 的进程
netstat -ano | findstr :7456
# 输出最后一列是 PID
taskkill /F /PID <PID>
```

或者换端口（在 `data/config.json` 里改，或通过环境变量）。

### Q3: `pnpm install` 报 `EACCES: permission denied`

另一个进程（VS Code / Docker / 杀毒）拿着 node_modules 里的文件。**关掉 VS Code 和 Docker**，再重试。

### Q4: `nvm use 22` 之后 `node` 还是 24

nvm-windows 在每个 shell 启动时自动应用当前目录的 `.nvmrc` 指定的版本。但如果**之前 PATH 里已经有 Node 24 优先**，可能冲突。解决：

```bash
nvm use 22
where node   # 应该列出 nvm 安装的 22.x 路径
```

如果还显示 `C:\Program Files\nodejs\node.exe`，把 `C:\Program Files\nodejs\` 从系统 PATH 里**删掉**（这是 Node 24 的旧位置，nvm-windows 装在 `%APPDATA%\nvm\`）。

### Q5: 能不能用 Node 24 + 装 VS Build Tools？

可以，但不推荐。VS Build Tools 装完 5GB+，每次 `pnpm install` 慢 10-15 分钟（编译 better-sqlite3）。**用 Node 22 跳过**。

如果坚持要 Node 24：

```bash
# 装 VS Build Tools 2022（不是 VS 2026，node-gyp 11 不认）
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
# 装完重启
pnpm install
```

## 五、不需要做的事

- ❌ **不需要**装 Docker / WSL — dev 模式纯 Node 进程
- ❌ **不需要**装 VS Code（虽然推荐，但任何编辑器都行）
- ❌ **不需要**装 GitHub CLI（虽然 `gh` 命令很方便，但不是 dev 必需）
- ❌ **不需要**改 PATH 改注册表（nvm-windows 自己管理）
