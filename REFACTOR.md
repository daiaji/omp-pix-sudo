# omp-pix-sudo 重构方案（NixOS 整合视角）

> 2026-11-24。基于本机实测：omp **19.1.1**（`/nix/store/…-omp-19.1.1`，来自 `nixos_data` 的 `llm-agents` 输入）、
> 插件 `0.3.31-omp.2`、sudo 1.9.17p2、bun 可用、node 26。
> 文中每条结论都标了「怎么验证的」；推断项标 `[推断]`；未能实测的标 `[待实测]`。
>
> **2026-11-24 审计修订（grilling 定稿）**：经对源码、nixos_data 配置与本机安装状态的逐条核对，
> 原方案整体可落地，但 §5 代码骨架有 4 处缺陷已按下文修正——
> ① §5.2 方案 A 会整文件替换 `config.yml`、删掉 `modelRoles`/`shellPath`（home-manager 必须全量接管）；
> ② flake input 的 `github:` URL 违反 AGENTS.md「codeload tarball + 可变 ref」，且本网络 git clone 实测会卡（300s 超时）；
> ③ 插件 flake 的 `version` 硬编码违反 SSOT（改从 `package.json` 派生）；
> ④ 装载作用域未定（定为 PC/MiniPC/AIO 三台代码机全装）。
> 已定决策：yolo/afk 直接删除；sudoers `timestamp_type=ppid` + `log_output`（pam_faillock 不做）；
> 门禁进 `checks` + `just verify` 四步；devShell bun-only；不进 tag_pins。
> 相关 postmortem：`GRILL-GOAL-LOCKUP.md`（执行期间 grill-goal gate 死锁，已修复扩展并修订 skill）。

---

## 0. TL;DR

| # | 动作 | 收益 | 验收 |
|---|---|---|---|
| **1** | 插件仓库加 `flake.nix`（只打包，不改代码），nixos_data 用 flake input 锁定 | 版本进 `flake.lock`、可回滚、`just verify` 可见；消灭 `curl refs/heads/main` 这种「每次都换代码」 | `nix build`；store 路径可直接被 omp 加载（已验证） |
| **2** | 声明式装载：home-manager **全量接管** `~/.omp/agent/config.yml`（现有键 + `extensions: [ "${pkg}/src/index.ts" ]`），PC/MiniPC/AIO 三台全装 | 不再需要 `omp plugin link`、不再需要 bun、`~/.omp/plugins` 零写入；modelRoles 等旧键不丢 | `omp config get extensions`；`--tools=sudo_run` 不再报 Unknown tool；config.yml 旧键齐全 |
| **3** | 用 **pin 住的 19.1.1 类型** 跑 `tsc`，把 34 个加载闭包内的类型错误清零 | 发现 3 个字段是从 **earendil pi** 抄来的，omp 18.4.10/19.1.1 都不认（`promptSnippet` / `exposure` / `renderShell`）；`options.isError` 恒 `undefined`。这类「上游 pi 有、omp 没有」正是本 repo 最初那个 bug 的同型错误 | `bunx tsc --noEmit` = 0 |
| **4** | 删除 `yolo` / `afk` 死分支（**没有任何调用点设置它**；定稿：直接删，不接宿主 approvalMode），修正 NixOS 文档里「yolo 免确认」的说法 | 文档与行为一致；少 2 个不可能走到的安全分支 | TUI 实测：有票据时仍弹 Allow 层；代码无 yolo/afk |
| **5** | 修 `agentDir()`：omp 下应落 `~/.omp/agent`，而不是 `~/.pi/agent` | `/pix` 设置的 `pix.json`、`binary.json` 不再写进一个 omp 从不读的目录 | `printenv PI_CODING_AGENT_DIR` 为空 → 文件出现在 `~/.omp/agent` |
| **6** | `sudo` 解析加 NixOS 已知路径 `/run/wrappers/bin/sudo`，并区分「找不到 sudo」与「认证失败」 | PATH 被清（systemd / sanitize 过的包装脚本）时给出可行动的报错，而不是 "authentication failed" | 在 `PATH=/usr/bin` 下调用 `sudo_run`，错误文案应是「找不到 sudo」 |
| **7** | 删 24 个不可达的 vendored 文件（71 → 47），`upstream.json` 做单一事实源 + 生成器 `--check` | 仓库小 1/3；升级上游 = 改 3 个版本号 + hash，重跑生成器 | `scripts/port --check`；`git diff --exit-code src` |
| **8** | sudoers 显式化 + 审计（P0-4）：`timestamp_type=ppid` + `log_output`；`checks.omp-pix-sudo-load` 配对门禁挂进 `just verify` 四步 | 票据语义防 sudo 默认漂移；每条 root 命令输出留 journal 证据；加载门禁机器可执行 | sudoers 两条 Defaults 无 log_input；`just verify PC` 四步绿 |

---

## 1. 核实过的现状（证据表）

### 1.1 安装形态：omp 19.1.1 用的是 `~/.omp/plugins`，不是文档写的 `~/.local/share/omp/plugins`

```console
$ omp plugin doctor
✔ plugins_directory: Found at /home/daiaji/.omp/plugins
✔ package_manifest: Found

$ ls -ld ~/.local/share/omp
ls: cannot access '/home/daiaji/.local/share/omp': No such file or directory
```

根因（读 19.1.1 bundle 里的 `DirResolver` / `getPluginsDir2`）：插件根是
`XDG_DATA_HOME/omp`（存在时）否则 `~/.omp`。两者是**二选一**，不是合并。

**陷阱（已用假 HOME 复现）**：照 `nixos_data/docs/omp-privilege.md` 的步骤
`mkdir -p ~/.local/share/omp/plugins`，会让 omp 19 把插件根切到 XDG：

```console
$ HOME=/tmp/fh1 omp plugin list                    # 只有 ~/.omp/plugins
● omp-pix-sudo@0.3.31-omp.2
$ HOME=/tmp/fh1 XDG_DATA_HOME=/tmp/fh1/.local/share omp plugin list
No plugins installed                                # 旧路径里的插件被整体忽略
```

也就是说：**现在能用的插件在 `~/.omp/plugins`；照文档再装一份到 `~/.local/share/omp` 会让它消失**。

### 1.2 不可变（store）路径 + 只读目录可以直接加载，无需 bun、无需 lock 文件

验证方法（本机实跑）：

```console
$ cp -r . /tmp/ro-plugin && chmod -R a-w /tmp/ro-plugin
$ omp -p --no-session --plugin-dir /tmp/ro-plugin --tools=sudo_run \
    'Use sudo_run with command "id". Quote the error exactly.'
sudo_run requires an interactive terminal session (mode: print, hasUI: false). …

$ SP=$(nix store add-path /tmp/ro-plugin --name omp-pix-sudo)
$ ls -ld $SP        # dr-xr-xr-x root root
$ omp -p --no-session --plugin-dir $SP --tools=sudo_run '…同上…'
sudo_run requires an interactive terminal session …      # 注册成功、执行到 guard
```

对照：不装插件时 `--tools=sudo_run` 是硬错误：

```console
$ omp -p --no-session --tools=sudo_run x
Error: Unknown tool in --tools: sudo_run.
```

**结论**：插件可以做成纯 Nix 包，`--plugin-dir <store>` 即可，运行期不写自己的目录、不装依赖。

### 1.3 声明式 `extensions` 可用（config.yml 全局层）

```console
$ rm -rf /tmp/fh4; mkdir -p /tmp/fh4/.omp/agent
$ printf 'extensions:\n  - %s/src/index.ts\n' "$SP" > /tmp/fh4/.omp/agent/config.yml
$ HOME=/tmp/fh4 omp -p --no-session --tools=sudo_run x     # 不再报 Unknown tool

$ HOME=/tmp/fh5 omp config list --scope global
Settings in the global layer:
  extensions = ["/nix/store/…-omp-pix-sudo/src/index.ts"] (array)
$ HOME=/tmp/fh5 omp config get extensions
["/nix/store/…-omp-pix-sudo/src/index.ts"]
```

`--plugin-dir` 也接受全局标志位置：`omp --plugin-dir <dir> plugin list` 正常（exit 0）。

### 1.4 宿主契约漂移：拿 19.1.1 的类型编译，50 个错误、34 个在**实际加载闭包**里

复现环境：`/tmp/tc`，`bun add -d typescript @types/node @oh-my-pi/pi-coding-agent@19.1.1 @oh-my-pi/pi-tui@19.1.1`，
`tsconfig` 用 `paths` 把 `@earendil-works/pi-*` 映射到 `@oh-my-pi/pi-*`，`include: ["src/**/*.ts"]`。
（这两个包在 npm 上都有 19.1.1 版本，因此类型检查是可行的，见 §3 R6。）

```
total errors 50 in reachable 34 in unreachable 16
files with errors 16: reachable 11, unreachable 5
```

其中**不是**「编译噪音」的几条：

| 位置 | 错误 | 含义 |
|---|---|---|
| `src/index.ts:264` | `'promptSnippet' does not exist in type 'ToolDefinition'` | 该字段来自 **`@earendil-works/pi-coding-agent@1.6.0`**（`dist/core/extensions/types.d.ts:481`）；omp 19.1.1 与 18.4.10 源码里 **0 次**出现，被静默丢弃 |
| `src/index.ts` (`exposure`) | 不在 `ToolDefinition` 里 | 同样是 earendil 字段（`ToolExposure`，`types.d.ts:500`）；omp 的对应概念是 `defaultInactive` / `loadMode`，所以 `exposure: "deferred"` 在 omp 上无效 |
| `src/index.ts` (`renderShell`) | 不在 19.1.1 类型里 | earendil 的 `renderShell?: "default" \| "self"`（`types.d.ts:489`）；omp 宿主源码 **0 次**。按无效处理 |
| `src/index.ts:611` | `Property 'isError' does not exist on type 'RenderOptionsLike'` | `wrapper.ts:109` 明确只构造 `{expanded, isPartial, spinnerFrame}`；所以 `options.isError` **恒为 undefined**，非 `sudoResult` 的错误配色分支是死代码 |
| `src/index.ts:289` | `Property 'command' does not exist on type 'unknown'` | 注册时 `parameters` 的 schema 类型没有推断到 `execute` 的 `params`（宿主 `registerTool` 泛型没落地），运行时没事，类型上等于放弃参数校验 |
| `src/lib.ts:25` | `boolean \| undefined` | `truncateHead` 的 `truncated` 现在是可选 |
| `pix-pretty/gate-overlay.ts:326` | `SelectListThemeConfig` 缺 `symbols` | 19.1.1 的 `SelectListTheme.symbols` 是必填；实现里用 `theme.symbols?.cursor ?? DEFAULT`（`select-list.ts:592`），**运行期安全**，只是类型债 |
| `pix-runtime/herdr-{state,notify}.ts:1` | `EventBus` 不再导出 | 类型名漂移；运行期用的是 `pi.events` 鸭子类型 |
| `pix-pretty/renderers.ts:65`、`modal-frame.ts` 等 | `"…"` 不能赋给 `"" \| Ellipsis` | 类型收窄，运行期接受字符串 |

这些错误**不会**让插件加载失败（所以 18.4.11 → 19.1.1 一直"看起来正常"），
但它们是下次升级时最先炸的地方，而且其中 3 个直接说明「某个功能已经悄悄没了」。

**由此得出一条硬规则（建议写进 CI）**：API 依据只能是 `@oh-my-pi/pi-coding-agent`；
`@earendil-works/*` 里有的字段/导入，只要 omp 没有，就当**不存在**。
`promptSnippet` / `exposure` / `renderShell` 这三个字段和仓库最初那个
`createLocalBashOperations` 崩溃是同一类错误：拿上游 pi 的 API 当 omp 的用。

### 1.5 `yolo` / `afk` 分支在本机是死代码（定稿：直接删除）

```console
$ grep -rn "setUnattendedMode" src git-src
src/pix-runtime/index.ts:21:	setUnattendedMode,        # 只 re-export
src/pix-runtime/herdr-state.ts:115:export function setUnattendedMode…
```

`getUnattendedMode(pi.events)` 读的是 pix-runtime 自己 WeakMap 里的状态，**没有任何代码写入它**；
omp 也不知道 pix 的这套 API。因此：

- `mode` 恒为 `"off"` → `yolo` 恒为 `false`、`afk` 分支永不命中。
- `nixos_data/docs/omp-privilege.md` 里「本机 `approvalMode=yolo` ⇒ 有票据时 root 命令全自动，
  只弹通知」**与代码不符**。实际是：有票据时仍弹 Allow/Deny 层，只是跳过密码。
- 除非装了 herdr 并通过共享事件总线调用 `setUnattendedMode`（本机没有）。

**处置（grilling 定稿）**：删除而非接宿主。删 `src/index.ts` 的 mode/afk/yolo 分支
与 pix-runtime 的 `setUnattendedMode`/`setYoloConsent`/`hasYoloConsent`/`UnattendedMode`
及 `resetUnattendedState` 里对应字段；**保留** `withAgentBlock`/`beginAgentBlock`/
`beginAgentActivity` 与 `herdr-notify.ts`（blocked 桥接仍被使用）。
TUI 端到端仍要实测一次（§7.1/7.2），确认删完行为不变。

### 1.6 pix 配置写到 omp 从不读的目录

```console
$ printenv PI_CODING_AGENT_DIR
（空）
$ omp -p --no-session --tools=bash '用 bash 执行：printenv PI_CODING_AGENT_DIR || echo UNSET'
UNSET
$ ls ~/.pi            # 不存在
```

omp 只在**启用 profile**（或显式 `--agent-dir`）时才 `process.env.PI_CODING_AGENT_DIR = dirs.agentDir`（bundle 里 `setProfile2`），
默认进程不设该变量。插件 `paths.ts` 的回退是 `~/.pi/agent`，于是：

- `/pix` 命令写的 `pix.json`、`binary.json`、`optimizer.json` 落在 `~/.pi/agent/`；
- omp 自己 `~/.omp/agent/` 里看不到它们，`omp config` / 备份 / 迁移都覆盖不到。

### 1.7 `sudo` 只按 PATH 解析

`lib.ts` → `spawnTool("sudo", …)` → `requireTool("sudo")`。catalog 里确实有
`sudo: { usedBy: ["pix-sudo"], os: UNIX, hint: { default: "install sudo" } }`
（`src/pix-runtime/binaries/catalog.ts:183`），但**没有 `knownPaths`**。
本机 sudo 在 `/run/wrappers/bin/sudo`，当前 PATH 恰好包含它。
从 systemd 服务、`.desktop`、或被 sanitize 过 PATH 的包装脚本启动 omp 时就会失败，
而失败会走到 `validatePassword` 的 catch → `executionError` → 最终报 **authentication failed**（误导）。

### 1.8 可达闭包 47/71，24 个文件永远不加载

从 `src/index.ts` 按 import 递归（ESM 会加载 re-export 的模块）：

```
47 reachable
24 unreachable: pix-pretty/{batch,chips,commands/fff,confirm,diff-render,diff,fff,icon-persist,
index,progress,provider-picker,resize,shell-tool,test-utils,tool-status,tools/context,
transient-error,types-diff.d,widget-format}, pix-runtime/{audio,binaries/index,os,safe-path,testing}
```

其中 5 个还带着 16 个类型错误。`chips.ts` / `provider-picker.ts` 里那两条
「`decodeKittyPrintable` 不存在」「`CustomEditor.insertTextAtCursor` 不存在」的旧结论，
本质上都是**死文件** —— 删掉它们，兼容性清单能少一整节。

---

## 2. NixOS 整合改进

### N1（P0）声明式安装：方案 A 定稿（HM 全量接管 config.yml），三台代码机全装

**定稿（grilling 确认）**：方案 A，作用域 = **PC/MiniPC/AIO 三台代码机全装**（home.nix
共用层写一次）；ISO/router 不装。骨架见 §5.2（已修订版）。

| 方案 | 机制 | 优点 | 代价 |
|---|---|---|---|
| **A. `config.yml` `extensions`**（✅ 定稿） | home-manager **全量接管** `~/.omp/agent/config.yml`（现有键 + `extensions: [ "${pkg}/src/index.ts" ]` 一起写） | 无包装脚本；所有 omp 调用方式（TUI/print/RPC/subcommand）都生效；`omp config get extensions` 可验证 | ⚠️ **原稿缺陷（已修正）**：`.text` 是整文件替换——只写 extensions 会删掉 `modelRoles`/`shellPath`/`setupVersion`。接管后 config.yml 只归 nix 管，不要在 TUI `/config` 里改 omp 设置（`/config` 原子重写会 rename 覆盖符号链接，switch 前的手改会丢） |
| B. 包装脚本（已否决） | `writeShellScriptBin "omp" '' exec ${omp}/bin/omp --plugin-dir ${pkg} "$@" ''` | 完全不碰 `~/.omp` | 系统级覆盖 `omp` 命令（要移除 `llmAgents.omp` 的 `bin/omp` 冲突）；`nix shell`/直接打 store 路径绕过包装；方案 A 定稿后无必要 |
| C. 塞进 `~/.omp/plugins`（已否决） | `home.file` 铺 `node_modules/omp-pix-sudo` + 手写 `package.json`/`omp-plugins.lock.json` | `omp plugin list/doctor` 能看到 | **最脆**：跟 omp 内部布局、lock 文件格式、`omp-plugin` 命令的写入行为耦合 |

**不要**继续用 `curl codeload…/refs/heads/main`：那是「每次都可能换一份以你的权限运行的代码」，
与 `docs/package-doctrine.md` 的「单一事实来源 + 可复现门禁」直接冲突。

### N2（P0）版本门禁：把「18.4.11 兼容」换成「对 pin 住的 omp 做编译 + 加载检查」

- 插件仓库 `flake.nix` 的 `devShells`/`checks` 固定 `@oh-my-pi/pi-coding-agent@<omp 版本>`（npm 有 19.1.1）。
- nixos_data 的 `checks` 里加一条 `omp-pix-sudo-load`：用 `llmAgents.omp`（同一份 store 二进制）
  在沙箱内跑一次「对照 + 插件」配对检查：

  ```bash
  # 对照：同一环境必须能报出 Unknown tool，否则说明检查本身失效
  omp -p --no-session --tools=sudo_run x 2>&1 | grep -q "Unknown tool in --tools: sudo_run"
  # 插件：不应再报
  ! omp -p --no-session --plugin-dir "${pkg}" --tools=sudo_run x 2>&1 | grep -q "Unknown tool"
  ```

  注意：**不要**用「退出码 0」当通过条件 —— 本机观察到假 HOME + `--plugin-dir` 时 omp 可能
  静默 exit 0（无输出）。配对检查才有判据。`[待实测]` 在纯沙箱（无 `PI_*` 环境、无 tty）里补一次。
- 这正好接上 `just verify` 的第 3 步（`nix eval … checks.…drvPath`）。

### N3（P0）修文档：三处硬错

`nixos_data/docs/omp-privilege.md`：

1. 安装路径 `~/.local/share/omp/plugins` → 19.1.1 实际是 `~/.omp/plugins`，
   且**创建 XDG 目录会整体切换插件根**（§1.1）。整节「安装形态」应改成 flake 输入，
   或至少改成 `--plugin-dir`/`config.yml` 的声明式做法。
2. 「yolo ⇒ 自动放行」→ 代码不读 omp 的 `approvalMode`（§1.5）。**定稿（grilling 确认）：
   直接删除**——删 `src/index.ts` 的 mode/afk/yolo 分支与 pix-runtime 导出的
   `setUnattendedMode`/`setYoloConsent`/`hasYoloConsent`/`UnattendedMode`；**保留**
   `withAgentBlock`/`beginAgentBlock`/`beginAgentActivity` 与 `herdr-notify.ts`
   （blocked 状态桥接仍被使用）。本节改为「有票据跳密码、每条命令仍弹 Allow/Deny」。
   不做「接宿主 approvalMode」路线。
3. 「omp 19.0.1 实测可加载」→ 现在是 19.1.1，且 19.1.1 的类型检查暴露了 3 个死字段
   （§1.4）。版本表要跟 `flake.lock` 走，别手抄。

另外：`docs/omp-privilege.md` 与插件 README 的「安装/机制」两处重复。按学说第 6 条
（单一事实来源），机制与安装留在插件 README，NixOS 文档只写「本机如何接进 flake + 验收命令」。

### N4（P1）`sudo` 解析与错误分类

- `catalog.ts` 给 `sudo` 加：

  ```ts
  sudo: {
    usedBy: ["pix-sudo"], os: UNIX,
    knownPaths: (_env, host) => host.os === "linux" ? ["/run/wrappers/bin/sudo"] : [],
    hint: { default: "install sudo (NixOS: security.sudo.enable = true)" },
  },
  ```

  `lookupTool` 的顺序是 `binary.json → <agentDir>/bin → knownPaths → PATH`，所以这是最小改动。
- `lib.ts` 把 `BinaryMissingError` 与认证失败分开：`errorKind: "no-binary"`，
  文案带「在 NixOS 上把 /run/wrappers/bin 放进 PATH，或用 binary.json 指定 sudo」。
- `hasValidTicket()` 加 5s 超时（`sudo -n true` 在 LDAP/SSSD 策略下会挂）。
- 可选：允许 `binary.json` 里 `sudo` 指向绝对路径（现有机制已支持，只要写文档）。

### N5（P1）票据语义：显式化（定稿：`timestamp_type=ppid`，已确认）

现状（读 `services.nix`：`security.sudo` 只有一条 rsync `NOPASSWD`，**没有任何 `Defaults`**）：

- 无 tty ⇒ sudo 选 `timestamp_type=ppid`，key 是 omp 进程；15 分钟 `timestamp_timeout`。
- 每 15 分钟要输一次密码；重启 omp 重新输。

**定稿（grilling 确认）**：`Defaults:daiaji timestamp_type=ppid`（显式化当前行为，
防未来 sudo 默认变化）。`global` 已否决——终端里任何一次 `sudo` 也会刷新票据，
等于把「终端 sudo」变成 agent 的门；`timestamp_timeout=0` 已否决（体验差）。

补充事实：本机 sudo 1.9.17p2 的 `-T` 是 **`--command-timeout`**，不是自定义票据文件
（`sudo --help` 实测），所以「给插件一个私有票据文件」在 1.9.x 上做不到；
想隔离只能靠 `timestamp_type` 的组合，或给 `sudo_run` 用独立用户（不推荐）。

### N6（P1）审计：要 `log_output`，不要 `log_input`

插件用 stdin 管道把密码喂给 `sudo -S`。sudoers 的 `log_input` 会把 **stdin 原样记进日志**，
等于把明文密码写进 journal。要审计就只开输出：

```nix
security.sudo.extraConfig = ''
  Defaults:daiaji log_output
'';
```

代价：所有 root 命令的 stdout/stderr 进 journal（含可能的大输出）；用
`journalctl -t sudo` 查。这是「TUI 人工闸门」之外唯一能事后举证的机制，值得开。

### N7（P2）PAM：先手测一次 `sudo -S -v`（定稿：只手测，pam_faillock 不纳入）

本仓库只在 `sshd` 的 PAM 栈上加了 OATH（`otp.nix`），sudo 的栈是发行默认（密码）。
但这是**系统级**假设，`[待实测]`：

```bash
printf '%s\n' '' | sudo -S -v; echo $?      # 输错一次，确认报 "incorrect password" 而不是 hang
```

**定稿（grilling 确认）**：授权模型不改（每命令弹层 + PAM 票据已经是合理形态）；
`pam_faillock`（连续错密码锁定）**不纳入本次**——那是系统策略变化，需单独评审
nixos-rebuild。若以后给 `security.pam.services.sudo` 加 fprintd/u2f，
`sudo -S -v` 的密码路径可能变成「必须按指纹」而管道里没有密码 → 插件会 3 次后失败。
到时候需要单独的 sudo 服务栈或拒绝该改动。

### N8（P2）状态目录：先修 `agentDir()`，再谈声明式管理

- 修复：`agentDir()` 在检测到 omp 宿主时回退到 `~/.omp/agent`
  （`PI_CODING_AGENT_DIR` → `~/.omp/agent`（存在时）→ `~/.pi/agent`）。
  这样 `/pix` 设置才和 omp 的状态在同一棵树里。
- 修好之前**不要**用 `home.file` 管 `pix.json`/`binary.json`：插件用
  `writeFileAtomicSync`（临时文件 + rename）覆盖，会把 home-manager 的符号链接
  静默替换成普通文件，`nixos-rebuild` 一跑又变回去，两边互相打架。
- 若一定要声明式：让插件支持只读配置（`PIX_CONFIG_FILE` 指向 store，写失败只报诊断），
  这是 R7 的一部分。

### N9（P2）与 `just verify` / 学说的接法（定稿修订）

- 插件是 **L3（用户日常）**：只有坐在桌前用 omp 的人才需要，不进 L1/L2。
- nixos_data 侧改动集中在三处：`flake.nix`（input + `checks`）、`omp.nix`（注释更新）、
  `justfile`（`verify` 三步变**四步**，带上 `omp-pix-sudo-load`）。
- **定稿（grilling 确认）**：`omp-pix-sudo` **不**加进 justfile 的 `tag_pins`
  （releases/latest 自动 bump）——插件升级必须与 omp 宿主版本人工核对，不适合自动追新。
- 回滚：改 flake input 的 tag 或 `extensions` 行 → switch；已拿到的票据 `sudo -k` 清掉。
- 卸载：删 input 行；`~/.omp/plugins` 里旧的 curl 安装可以删（并注意 §1.1 的 XDG 陷阱：
  删之前确认没有 `~/.local/share/omp`）。

---

## 3. 插件仓库重构（代码层）

### R1（P1）单一事实来源：`upstream.json` + 生成器 + `--check`

现在 `git-src/`（660K，72 文件）与 `src/`（600K，71 文件）是**手抄的两份**，
README 的版本表是第三份。升级上游时必须人肉保证三处一致。

目标：

```
upstream.json          # 三个包：name / version / npm tarball URL / sha256（README 表格的数据源）
git-src/               # 只作为「上游原样」参考，不参与运行
scripts/sync-upstream   # 按 upstream.json 下载、校验 sha256、解包到 git-src/
scripts/port            # git-src/ + patches/ → src/（纯机械：git-src 拷贝 + import 重写 + 打补丁）
scripts/port --check    # 重跑生成到临时目录，与 src/ 比对，不一致则退出 1
```

- 实质性 port 改动只有 5 组（删 `user_bash`、`pi.zod`、渲染器签名、managed timers、非交互 guard，
  再加 import 重写）。把它们固化成 `patches/*.patch` 或生成器里的显式规则。
- 升级流程：改 `upstream.json` → `just sync` → `just port` → review diff → 跑测试 → 提交。
- CI：`port --check` + `tsc` + `bun test` + 加载检查（§2 的 checks）。

### R2（P1）删掉 24 个不可达文件

§1.8 的清单。删完：

- `src` 71 → 47 文件；
- 兼容性清单少掉 `decodeKittyPrintable`、`CustomEditor` 两整段（它们在死文件里）；
- 类型错误从 50 → 34（剩下的全在加载闭包内，必须修）。

保留 `provider-picker.ts` 等只有一个理由：以后要暴露子命令。真需要时从 `git-src` 恢复即可，
生成器能重现。

### R3（P1）加一层 `src/host/` 兼容层

现在宿主假设散落在 `index.ts`、`paths.ts`、`gate-overlay.ts`、`exec.ts`。把「omp 差异」集中：

```
src/host/
  compat.ts      # pi.zod / registerTool 字段 / render options 形状 / mode+hasUI guard
  agent-dir.ts   # PI_CODING_AGENT_DIR → ~/.omp/agent → ~/.pi/agent
  version.ts     # 宿主版本探测 + 不兼容字段的一次性诊断
```

`compat.ts` 必须只 import `@oh-my-pi/*` 的类型（`@earendil-works/*` 只作对照）。
`renderShell` / `promptSnippet` / `exposure` 这类「earendil 有、omp 无」的字段不允许再出现 ——
见 §1.4 的硬规则。

收益：下次 18→19 这种迁移只改一个目录，`index.ts` 不跟着抖。

### R4（P1）拆 `index.ts`（687 行）

```
src/index.ts        # 只做注册：schema、description、绑定 execute/render
src/tool/execute.ts # 权限流程状态机（afk → no-ui → ticket → overlay → run → truncate）
src/tool/render.ts  # 卡片渲染 + 折叠
src/tool/state.ts   # WeakMap<args, CollapseState> + RENDER_TIMERS
```

`COLLAPSE_STATES` 的注释写得很好（为什么用 args 身份而不是 toolCallId），
拆文件时**原样保留注释**——那是这次 port 最贵的知识。

### R5（P1）测试：3 个已修 bug 各留一个回归用例

`bun test`（bun 已是 omp 的安装工具，本机可用）：

| 用例 | 防的是什么 |
|---|---|
| 同一 `args` 引用调用 2 次 renderResult → 只 arm 1 个 timer；不同 args → 2 个 | 0.3.31-omp.1 的「每帧一个 interval + Map 泄漏」 |
| deny / timeout / cancel 三个分支 `isError === true` | 把「没跑」回报成成功 |
| `spawnSudo` 正常结束后，caller signal 的 listener 数回到原值 | abort listener 泄漏 |
| `truncate`：单行超 50KB、UTF-8 多字节边界、0 行 | 输出截断 |

配套：`test/stubs/pi-coding-agent.ts`、`test/stubs/pi-tui.ts`，让 `src/index.ts` 在
omp 进程外可导入；用 stub `pi` 调一次 default export，断言 `registerTool` 拿到
`name === "sudo_run"` 且 `parameters` 能解析 `{command}`。**这才是模型无关的注册检查**，
比用真二进制跑 print 模式稳（§N2 的静默 exit 0 陷阱）。

### R6（P1）类型检查：pin 到宿主的 npm 包

`package.json`：`devDependencies` 从 `@oh-my-pi/pi-coding-agent ^18.4.10` 改成与 flake 里 omp
完全相同的版本（当前 19.1.1），再加 `@oh-my-pi/pi-tui`、`@types/node`、`typescript`。

`tsconfig.json` 要点（TS 6 已移除 `baseUrl`，别抄网上旧配置）：

```jsonc
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "allowImportingTsExtensions": true,
    "paths": {
      "@earendil-works/pi-coding-agent": ["./node_modules/@oh-my-pi/pi-coding-agent"],
      "@earendil-works/pi-tui": ["./node_modules/@oh-my-pi/pi-tui"]
    }
  }
}
```

然后逐个消灭 §1.4 的 34 个错误；尤其：

- 删 `promptSnippet`、`exposure`、`renderShell`（三者只在 earendil pi 里存在，omp 不认；`exposure` 的「不进初始顶层工具集」
  由 19.1.1 的默认 `loadMode: "discoverable"` 自动满足 —— **不要**改成 `defaultInactive: true`，
  那个字段要求注册方自己用 `setActiveTools()` 激活，会把工具变成默认不可用）；
- `RenderOptionsLike` 去掉 `isError`。非 `sudoResult` 的错误样式改用插件自己的
  `details.outcome` 判定；若宿主 `AgentToolResult` 在 pin 的版本里确有 `isError`，再叠加使用；

### R7（P2）sudo 运行器硬化

- `knownPaths`（§N4）、`hasValidTicket` 超时、错误分类 `no-binary` / `auth` / `exec`。
- 密码路径不变：stdin 管道、不落盘、不进上下文（这是现有实现最正确的部分，别动）。
- `sudo -S` 的 prompt 过滤目前匹配 `^\[sudo\] password`；若将来 sudoers 改 `passprompt`
  或系统语言变化，会漏。改成「遇到 prompt 就把该行吞掉并记住已提示」的宽匹配更稳，
  但注意不要吞掉命令自己的输出。
- 只读配置支持（可选）：`PIX_CONFIG_FILE` 指向 store 时，写失败只报诊断、不改快照。

### R8（P2）发布与版本

- 版本继续跟上游：`0.3.31-omp.N`；任何修复都 `N+1`（下一个是 `0.3.31-omp.3`）。
- 打 tag，flake input 用 tag，不用分支。
- `package.json` 的 `files` 已排除 `git-src`（正确）；把 `REFACTOR.md`、测试、`scripts/`
  也留在仓库但不进包。
- README 的「Tested in」写 omp 19.1.1 + 类型检查结果，别写「兼容 18.4.10」这种没有门禁的句子。

---

## 4. 分阶段落地（定稿：yolo/afk 直接删除，sudoers P2 全做，verify 四步）

| 阶段 | 内容 | 验收（全部可执行） |
|---|---|---|
| **P0-1** | 加 `flake.nix`（打包 + bun-only devShell；version 从 package.json 派生），打 tag `v0.3.31-omp.3` | `nix build .#`；`omp -p --no-session --plugin-dir ./result/share/omp-pix-sudo --tools=sudo_run x` 不报 Unknown tool |
| **P0-2** | nixos_data 加 input（codeload tag URL）+ HM 全量接管 `config.yml`（现有键 + extensions，三台全装）；改 `omp.nix` 注释 | `nixos-rebuild build`；`omp config get extensions` 是 store 路径；`modelRoles` 仍在；TUI 里 `sudo_run id` 首次要密码 |
| **P0-3** | 修 `docs/omp-privilege.md`（路径 / yolo / 版本）+ REFACTOR.md 修订 | 文档里的每条命令本机跑一遍 |
| **P0-4** | `checks.omp-pix-sudo-load` 配对门禁 + `just verify` 四步；sudoers `timestamp_type=ppid` + `log_output` | `just verify PC` 四步绿；sudoers 两条 Defaults 无 log_input；PAM 手测记录在案 |
| **P1-1** | `tsc` 清零（含删死字段 promptSnippet/exposure/renderShell）；删 yolo/afk 死分支（保留 withAgentBlock/herdr-notify）；加 `bun test` + stub 注册测试 | `bunx tsc --noEmit` 0；`bun test` 全绿；代码里无 yolo/afk |
| **P1-2** | `upstream.json` + `sync`/`port --check`；删 24 个死文件 | `scripts/port --check` 与 `src` 无差异；`tsc` 仍 0 |
| **P1-3** | `src/host/`、拆 `index.ts`、sudo 硬化（knownPaths/超时/错误分类）、`agentDir()` 修复 | stub 测试覆盖错误分支；`PATH=/usr/bin` 下报「找不到 sudo」；`~/.pi` 不再新增 |
| **P2** | TUI 端到端手测；README/文档版本表述定稿（Tested in omp 19.1.1） | TUI 实测清单通过；有票据仍弹 Allow 层 |

顺序理由：P0 全部是「不碰行为」的改动，先让版本可复现、让加载路径可验证；
P1 才动代码；`yolo/afk` 已定稿删除（不再「接宿主 API」）；`agentDir()` 修复从
P2 提前到 P1-3（P0-2 的 config.yml 接管要求 `~/.omp/agent` 是真实状态目录）。

---

## 5. 代码骨架

### 5.1 插件仓库 `flake.nix`（已按审计修订）

```nix
{
  description = "omp-pix-sudo — sudo_run for omp (port of @xynogen/pix-sudo)";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
      # 审计修正 ③：SSOT——版本号只存在于 package.json，flake 不手抄第二份。
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in {
      packages = forAll (pkgs: {
        default = pkgs.stdenv.mkDerivation {
          pname = "omp-pix-sudo";
          inherit version;
          # 只带运行所需：src + package.json + LICENSE（git-src/test/scripts 不进 store 闭包）
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./src ./package.json ./LICENSE ];
          };
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/omp-pix-sudo
            cp -r src package.json LICENSE $out/share/omp-pix-sudo/
            runHook postInstall
          '';
          meta.license = pkgs.lib.licenses.mit;
        };
      });
      # 审计修订：devShell bun-only。omp 运行时是 bun，不带 node——双运行时只会
      # 制造「本机能跑 CI 不能跑」的漂移。typescript 用 bunx 拉（devDeps 精确 pin）。
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [ bun typescript ];
        };
      });
      # 注意：真正的「用 omp 二进制加载」检查放在 nixos_data 的 checks 里（那里有 llm-agents 输入），
      # 本仓库不把 339M 的 omp 拉进闭包。
    };
}
```

`package.json` 的 `omp.extensions` 指向 `./src/index.ts`，复制目录时保持相对结构即可。

### 5.2 nixos_data：input + 装载（已按审计修订）

```nix
# flake.nix inputs —— 审计修正 ②：遵守 AGENTS.md「codeload tarball + 可变 ref」。
# github: URL 在本网络会卡 git clone（omp-privilege.md 实测 300s 超时）；
# codeload 直链 0.6–3.3s 稳定。tag 须先在插件仓库打好并 push。
omp-pix-sudo.url = "tarball+https://codeload.github.com/steimerbyte/omp-pix-sudo/tar.gz/refs/tags/v0.3.31-omp.3";
```

**作用域（审计修正 ④）**：`omp.nix` 被 PC/MiniPC/AIO 三台加载，`home.nix` 也是
三台共用。定稿：**三台代码机全装**（extensions 写在共用的 home-manager 层一次生效），
ISO/router 等其它 host 不装。若未来要按主机门控，用 `osConfig.networking.hostName`
判断，不要复制模块。

```nix
# 方案 A（定稿）：home-manager 全量接管 ~/.omp/agent/config.yml。
# 审计修正 ①：原稿的 .text 只写 extensions 会整文件替换、删掉 modelRoles /
# shellPath / setupVersion —— 迁移时必须先读现值，全部键一起写。
# 接管后 config.yml 只归 nix 管：不要在 TUI /config 里改 omp 设置
# （/config 原子重写会 rename 覆盖符号链接，switch 之前的手改会丢）。
{ inputs, ... }:
let
  pixSudo = inputs.omp-pix-sudo.packages.${pkgs.stdenv.hostPlatform.system}.default;
in {
  home.file.".omp/agent/config.yml".text = ''
    # managed by home-manager — do not edit
    setupVersion: 3
    shellPath: /run/current-system/sw/bin/bash
    modelRoles:
      default: commandcode/z-ai/glm-5.3-flash:high
    hideThinkingBlock: false
    extensions:
      - ${pixSudo}/share/omp-pix-sudo/src/index.ts
  '';
}
```

注意：方案 A 依赖 `~/.omp/agent` 是默认 agent dir；若以后设 `PI_CODING_AGENT_DIR`
或 profile，路径跟着变。迁移后清理旧 `~/.omp/plugins`（`omp-pix-sudo` 目录、
`node_modules`、`omp-plugins.lock.json`、`package.json`），并确认
`~/.local/share/omp` 不存在（XDG 切根陷阱，§1.1）。

~~方案 B：包装脚本~~（备选，已否决：nix shell / 直接 store 路径可绕过包装，
且要处理 `llmAgents.omp` 的 bin/omp 冲突；config.yml 全量接管后无必要）。

### 5.3 `checks`（配对检查，避免「静默 exit 0」误判）

```nix
# flake.nix 的 let 里：pixSudo = inputs.omp-pix-sudo.packages.${system}.default;
#                    omp = inputs.llm-agents.packages.${system}.omp;
checks.${system}.omp-pix-sudo-load =
  pkgs.runCommand "omp-pix-sudo-load" {
    nativeBuildInputs = [ omp ];
  } ''
    export HOME=$TMPDIR/home
    mkdir -p "$HOME"

    # 1) 对照：没有插件时，宿主必须报 Unknown tool —— 证明本检查有判别力
    if ! omp -p --no-session --tools=sudo_run x 2>&1 | grep -q "Unknown tool in --tools: sudo_run"; then
      echo "control failed: host did not report Unknown tool"; exit 1
    fi

    # 2) 插件：不应再报
    if omp -p --no-session --plugin-dir ${pixSudo} --tools=sudo_run x 2>&1 \
         | grep -q "Unknown tool in --tools: sudo_run"; then
      echo "plugin did not register sudo_run"; exit 1
    fi

    touch $out
  '';
```

### 5.4 审计（sudoers，定稿进 P0-4）

```nix
security.sudo.extraConfig = ''
  Defaults:daiaji timestamp_type=ppid
  Defaults:daiaji log_output
'';
```

写进 `nixos_data/services.nix` 的 `security.sudo.extraConfig`；PAM 手测
（`printf '' | sudo -S -v` 应报 incorrect 而非 hang）一并记录。pam_faillock 不纳入。

---

## 6. 风险与取舍（定稿）

| 决定 | 风险 | 选择 |
|---|---|---|
| config.yml 声明式 vs 包装脚本 | config.yml 会被 `/config` 重写；包装脚本只覆盖 `omp` 命令 | **定稿：只用 config.yml（HM 全量接管）**，且不在 TUI 里改 omp 设置；包装脚本否决 |
| `timestamp_type=global` | 终端 sudo 与 agent 共享票据，一次授权放大的范围 | **定稿：保持 ppid 并显式化**；global 否决（yolo 已删，更无接它的理由） |
| `log_output` | journal 体积、敏感输出进 journal | 只开 `log_output`；**绝不**开 `log_input`（stdin 是密码） |
| 删 yolo/afk | 少一个「可控免确认」能力 | **定稿：直接删除**，不留死分支，不接宿主 approvalMode；每条命令弹层是结构性保证 |
| 删 24 个文件 | 以后要用子命令功能需恢复 | 生成器可重现；`git-src` 保留即无损 |
| 固定 devDep 19.1.1 | 与运行时 store 里的 omp 必须同版本 | 在 `flake.lock` 与 `package.json` 间加一致性检查（`scripts/check-versions`） |

**不做**（沿用已有评审结论 + grilling 定稿）：sudoers 窗口、run0/polkit、命令白名单、
specialisation、pam_faillock、tag_pins 自动 bump。本方案不碰这些边界。

---

## 7. 未验证项（诚实清单，按定稿更新）

1. **TUI 端到端**：Allow 弹层、密码输入、倒计时、`withAgentBlock` 在 omp 19.1.1 上的
   `events.emit("pix:agent-state", …)` 是否被宿主接受 —— 全部 `[待实测]`（P2 阶段做）。
2. 有票据时是否仍弹 Allow（按代码是，需肉眼确认，见 §1.5）。
3. `renderShell: "self"` 在 omp 上无效（earendil 有、omp 18.4.10/19.1.1 都没有）；删掉后卡片边框是否变化需 TUI 对比一次。
4. ~~omp 宿主是否可能通过 `ExtensionAPI` 暴露 approvalMode~~ —— **已定稿：无需查**。
   yolo/afk 直接删除，不做「接宿主 approvalMode」路线（§1.5）。
5. Nix 沙箱里 omp 的静默退出行为（§5.3 的配对检查已规避，但值得在 CI 里跑一次确认）。

---

## 附：本次核实用到的命令

```bash
omp --version; omp plugin list; omp plugin doctor; omp config list --scope global
readlink -f ~/.omp/plugins/node_modules/omp-pix-sudo
printenv PI_CODING_AGENT_DIR; ls ~/.local/share/omp ~/.omp/plugins
SP=$(nix store add-path /tmp/ro-plugin --name omp-pix-sudo)
omp -p --no-session --plugin-dir "$SP" --tools=sudo_run '…'   # store 只读路径加载
HOME=/tmp/fh5 omp config get extensions                        # 声明式 extensions
bunx tsc -p /tmp/tc/tsconfig.json                              # 19.1.1 类型检查（50 错）
sudo --help | grep -i timestamp                                # -T 是 command-timeout

# 字段来源对照（证明 promptSnippet/exposure/renderShell 来自 earendil，而不是 omp）
grep -rn "promptSnippet\|renderShell\|exposure" \
  node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
grep -rn "promptSnippet\|renderShell" node_modules/@oh-my-pi/pi-coding-agent/src | wc -l   # 0
```
