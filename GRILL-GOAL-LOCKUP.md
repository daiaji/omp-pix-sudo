# grill-goal 死锁 postmortem + 修复提案

日期：2026-11-24。事故：会话 `01a20c24-9bdd-70f7-9a65-4a60317a7d3d` 被 grill-goal
read-only gate 永久锁死，所有写操作（bash 重定向、write、eval、out://）全部被
`"Grill-goal blocked a potentially mutating command"` 拦截，且 `propose_goal`
报 `"No armed interview"`，无任何 omp 命令可解。只能手改 JSONL 救援。

## 死锁原理（源码级）

文件：`~/.omp/agent/extensions/grill-goal.ts`、`~/.omp/agent/extensions/shared/goal-guards.ts`。
调用链涉及四个状态位，分布在三处，彼此无法原子更新：

| 状态位 | 位置 | 写入时机 |
| --- | --- | --- |
| `state.phase` (`interview`/`proposed`/`idle`) | 扩展内存态，快照持久化在会话 JSONL 的 custom entry `omp.grill-goal.state` | `propose_goal` 立即置 `proposed`；`agent_end` 中 goal 创建**成功后**才置 `idle` |
| `pending`（objective 暂存） | 仅内存 | `propose_goal` 写入；`agent_end` 无论成败一律消费清空 |
| goal 实体 | omp `sessionModes`，**非持久**（agent.db 无 goal 表） | `agent_end` 里 `startGoal()` 成功才创建 |
| gate 拦截条件 | `tool_call` handler：`state.phase !== "idle"` 即拦 | — |

时序：

```
propose_goal (turn 内)
  state.phase = "proposed"; pending = objective   ← gate 立即收紧为"只拦不跑"
  返回 "Goal queued. It starts when this turn ends."

agent_end (turn 结束)
  startGoal(): modes.set({mode:"goal",...}) 重试 6 次 × 250ms
  ├── turn 仍 busy（例如 aborted/续命/排队中的续turn）→ "the session stayed busy"
  │     pending = undefined  ← 已消费，objective 丢失
  │     state.phase 仍是 "proposed"  ← gate 不解除
  │     且没有任何重试路径 → 死锁成形
  └── 成功 → phase="idle"，gate 解除，一切正常
```

致命点有四个：

1. **gate 解除条件绑死在 `agent_end` 成功路径**。`startGoal` 失败时只
   `ctx.ui.notify` 一条 warning（TUI 角落，模型看不见），`phase` 保持
   `proposed`。此后每轮 turn：`tool_call` 拦写、`before_agent_start` 注入
   "goal queued, do not start work"，turn 被工具调用不断续命，`agent_end`
   每次都因 `stopReason:"aborted"` 等非正常结束重走失败路径。实测日志
   （`~/.omp/logs/omp.2026-11-24.950783.log`）连续多条
   `agent_end maintenance routing … stopReason:"aborted" goalModeEnabled:false`。
2. **`pending` 单发不重试**。`agent_end` 开头 `if (!pending) return;`
   随后无条件 `pending = undefined`。busy 失败即永久丢失 objective，模型端
   只剩 `propose_goal` 这条路，而它要求 `state.phase === "interview"`，
   当前是 `proposed` → `"No armed interview"`。两条路同时封死。
3. **恢复语义自锁**。`restore()`（session_start/branch/tree 时执行）从
   JSONL branch 最后一条 `omp.grill-goal.state` 恢复 `phase="proposed"`。
   也就是说重启进程都逃不掉，重启只会回到同一个锁死态。
4. **会话文件是树不是流**。exit 时进程 append 的 `session_exit` 与后续
   resume 的 user 消息构成新链，任何在进程存活期间写入的状态修改都会成为
   旁支，被 `getBranch()` 的 parent 回溯跳过。手工解锁必须赶在退出之后、
   resume 之前落盘（见下文操作序列）。

另有一个次生坑：`agent_end` 的调用前提是 turn 真正结束，而该扩展自身的
`before_agent_start` 注入让模型"别干活，等 turn 结束"，模型每轮仍被拦拦改改，
turn 反而被续——扩展亲手阻止了自己依赖的那个事件发生。

## 本次救援（可复用的手工解法）

goal/gate 是纯运行态，agent.db 无表，唯一持久化在会话 JSONL：

```
~/.omp/agent/sessions/<slugged-cwd>/<ts>_<sessionid>.jsonl
```

每条 entry 形如：

```json
{"type":"custom","customType":"omp.grill-goal.state",
 "data":{"phase":"proposed","topic":"...","checkpoint":"...","updatedAt":...},
 "id":"7d07814d","parentId":"<上一行id>","timestamp":"...","runtime":{"version":"19.1.1"}}
```

解法 = 仿照 `/grill-goal stop` 的写盘，**append** 一条 `phase:"idle"` entry，
不改任何已有行。但要挂对位置——见下面的关键坑。

### 关键坑：JSONL 是树，不是流

`getBranch()` 从**当前叶子**沿 `parentId` 回溯到根，文件里"最后一行"≠ branch
末条。本次实测踩了两次：

1. 第一次 append 在活进程运行期间（parent 接当时的末行）。退出时进程在其
   自己的末行下 append 一条 `session_exit`（`customType: "session_exit"`），
   resume 的 user 消息又挂在 session_exit 下 → 我那条 idle entry 成了旁支，
   restore 沿新链回溯看不到它 → 仍读到旧的 `proposed`，锁死如故。
2. 正确顺序：**先退出进程 → 读当前末行的 id → 把 idle entry append 成新的
   文件末行（parent 接末行 id）**。这样 resume 时它天然在叶子上。

操作序列（可复用）：

```
1. 用户退出 omp（进程 append 完 session_exit，不再写文件）
2. tail -1 会话.jsonl 取末行 id 作为 parentId
3. append idle entry（id 自拟 8 位 hex，timestamp 取当前 UTC ISO）
4. 用户 resume；session_start → restore() 读到 idle → gate 解除
```

entry 模板（本次实际使用）：

```json
{"type":"custom","customType":"omp.grill-goal.state",
 "data":{"phase":"idle","topic":"","checkpoint":"","updatedAt":1795504703123},
 "id":"b71e9a04","parentId":"39f6043a","timestamp":"2026-11-24T07:08:23.123Z",
 "runtime":{"version":"19.1.1"}}
```

`restore()` 读到 idle 后：gate 解除、`propose_goal`/`grill_goal_checkpoint`
工具卸载、checkpoint 清空（checkpoint 本来就随 phase 一起重置；想留现场就
写 `interview` 重走 propose，但那会重新武装 gate，不建议）。

其他注意：

- `*.lock.os` 0 字节锁文件无进程持有时是陈旧物，可忽略。
- `agent_end` 在 `stopReason:"aborted"` 下照样触发并消费 `pending`，
  所以"goal 没建但 pending 已丢"是常见形态，不是个例。
- 活进程持有 JSONL 的 write-only fd 时 append 与其追加写不冲突，但**没意义**：
  进程内存态已经是 proposed，restore 只在 session_start/branch/tree 时跑。
  要解锁必须退出再进。

## 修复建议（按优先级）

0. **修复方向的第一性结论**：`proposed` 状态必须可逃逸。要么失败退回
   `interview`（保 pending），要么 proposed 不拦写。只要还有任何路径能把
   会话带进"既不是 interview 也不是 idle、且 pending 已丢"的状态，死锁就还在。

1. **失败时不丢 pending，退回 interview**（最小修复）：
   `startGoal` 返回 `{ok:false}` 时，不要无条件清 `pending`；把
   `state.phase` 回退到 `"interview"` 并 persist，让模型重发
   `propose_goal` 或用户 `/grill-goal stop` 可解。当前代码两条路全死。
2. **下轮重试而非当轮重试**：`startGoal` busy 时用 `ctx.setTimeout`
   安排一个延迟重试（或在 `before_agent_start` 里若 `pending` 存在则
   再尝试一次），而不是指望一个永不结束的 turn。
3. **gate 解除条件与 goal 解耦**：`tool_call` 拦截只在
   `phase === "interview"` 时收紧；`proposed` 阶段放开写、只在
   system prompt 里提示"goal 已排队"。`proposed` 拦写是死锁的主要伤害面。
4. **止损命令自愈不可达**：`/grill-goal stop` 是 TUI 命令，模型无法调用，
   用户在锁死期间也没有被 notify 提示"可以 stop"。失败时 notify 文本里
   应明确给出 `/grill-goal stop` 这个逃生口。
5. **checkpoint 丢失语义**：`stop`/`idle` 会把 checkpoint 一并清掉。
   若想在解锁后保留现场用于续跑，`idle` entry 可带一个归档字段或另存
   `~/.omp/agent/grill-goal-archive/<sessionid>.md`。

## 涉及代码位置

- `grill-goal.ts`：`persist()`（appendEntry `omp.grill-goal.state`）、
  `restore()`（branch 末条恢复）、`tool_call` handler（gate）、
  `agent_end` handler（`startGoal` 调用点）。
- `shared/goal-guards.ts`：`startGoal()` 六次 busy 重试后
  `"the session stayed busy"`。
- 事故现场备份：`~/.omp/agent/agent.db.bak-rescue{,-shm,-wal}`（未动 db，
  备份仅是流程保险）。

## 救援结果（2026-11-24 07:08）

- 第 939 行落盘 idle entry `b71e9a04`，parent 接退出后的末行 `39f6043a`
  （session_exit），已验证其位于叶子祖先链、是 branch 上最后一条 grill state。
- 用户 resume 即解锁。两次失败尝试（628 行前旁支）留档教训如上。
- 会话内 17 项 todo 与全部消息未被改动；goal 实体从未创建，无需重建，
  resume 后直接开工即可。
