# 围棋对战 AI（WeiqiGo.com 自动应手机器人）

一个能接入 [WeiqiGo.com](https://weiqigo.com) 的围棋 AI：好友在私人房间里下子后，机器人会**立即**用围棋引擎计算并自动落子，目标是赢下对局。

内置**两套引擎**，自动选择：

- **KataGo**（推荐，默认）：开源最强围棋 AI，19 路棋力可达强业余甚至职业级，完胜普通棋友。
- **自研 MCTS**（回退）：无需任何下载即可运行，9/13 路很强，19 路约入门到中级。

## 功能

- 自动创建私人房间并生成邀请链接，或通过好友的链接加入房间
- 对手落子后自动响应（引擎思考约 2–3 秒后立即落子）
- 完整支持 9 / 13 / 19 路棋盘、提子、禁着、劫、停一手、数子终局
- 可选登录账号（记录胜负/等级分），也可游客身份对战

## 环境要求

- [Node.js](https://nodejs.org) 18 或更高（本项目在 Node 24 上测试通过）

## 安装

```bash
npm install
```

## 安装 KataGo（一次性，约 94 MB）

运行下面的脚本会自动下载 KataGo 程序（CPU/OpenCL 两个后端）和神经网络模型：

```bash
node --use-system-ca setup-katago.mjs
```

> 若你本机可直接访问 GitHub 与 katagotraining.org，通常不需要 `--use-system-ca`，直接 `node setup-katago.mjs` 即可。下载完成后会在 `katago/` 目录下生成引擎和模型。

不想用 KataGo、只想用内置 MCTS 引擎时，可跳过此步骤，并把 `config.json` 里 `engine.type` 设为 `"mcts"`。

## 配置（config.json）

```json
{
  "baseUrl": "https://weiqigo.com",
  "auth": { "email": "", "password": "", "username": "GoBotPlayer", "token": "" },
  "mode": "create",
  "roomUrl": "",
  "playerName": "GoBot",
  "boardSize": 9,
  "timeControl": "none",
  "engine": { "timeBudgetMs": 2500, "workers": 0, "komi": 7.5 },
  "moveDelayMs": 250,
  "maxMoves": 0,
  "autoRematch": false,
  "logChat": true
}
```

| 字段 | 说明 |
| --- | --- |
| `auth.email/password` | 账号密码（留空则以游客身份对战）。填了会自动登录并缓存 token |
| `auth.token` | 已缓存的登录 token（登录后自动写入，无需手填） |
| `mode` | `create` = 机器人建房并打印邀请链接；`join` = 机器人加入好友的房 |
| `roomUrl` | `mode=join` 时填入好友发来的邀请链接（含 `?room=..&token=..`） |
| `playerName` | 游客身份时的显示昵称 |
| `boardSize` | 9 / 13 / 19。**9 路赢面最大**，19 路用 KataGo 也几乎必胜 |
| `timeControl` | `none`（不限时，推荐）或 `standard`（限时） |
| `engine.type` | `auto`（有 KataGo 就用 KataGo，否则 MCTS）、`katago`、`mcts` |
| `engine.timeBudgetMs` | 每步思考时间（毫秒）。越大越强、越慢 |
| `engine.workers` | MCTS 并行线程数，`0` = 自动（仅 MCTS 引擎使用） |
| `engine.komi` | 贴目（中国规则默认 7.5） |
| `engine.katago.backend` | `auto`（优先 GPU/OpenCL，回退 CPU/Eigen）、`opencl`、`eigen` |
| `moveDelayMs` | 收到对手落子后的响应延迟（毫秒） |
| `maxMoves` | 最大手数保险（`0` = 自动，约为棋盘面积 ×2，防止两个 AI 互下陷入打劫循环） |

## 使用

### 方式一：机器人建房，好友来战

1. 确认 `config.json` 里 `mode = "create"`。
2. 运行：
   ```bash
   node bot.js
   ```
3. 控制台会打印一条邀请链接，把它发给好友。
4. 好友在浏览器打开链接、输入昵称即可开始。机器人会自动落子。

### 方式二：好友建房，机器人加入

1. 让好友在 [weiqigo.com/online-battle/](https://weiqigo.com/online-battle/) 勾选 **Private room** 建房，把邀请链接发给你。
2. 把链接填到 `config.json` 的 `roomUrl`，并把 `mode` 改为 `"join"`。
3. 运行 `node bot.js`。

### 登录 / 注册账号

```bash
# 注册新账号（config.json 里需填好 auth.username / email / password）
node bot.js --register

# 用已有账号登录并验证
node bot.js --login
```

## 如何让它「稳赢」好友

- **接入 KataGo 后（推荐）**：19 路也几乎必胜，`engine.timeBudgetMs` 默认 2500ms 即可；想要更狠可调到 5000+。
- **9 路棋盘**：即使只用内置 MCTS 也几乎必胜；KataGo 更是碾压。
- 双方都用「不限时」（`timeControl: "none"`）可避免超时判负。

## 目录结构

```
围棋/
├─ bot.js             # 主程序：认证 + Socket 对局 + 自动应手
├─ config.json        # 用户配置
├─ go-engine.js       # 围棋规则引擎（提子/禁着/劫/中国规则数子）
├─ setup-katago.mjs   # 一键下载 KataGo 引擎 + 模型
├─ engine/
│  ├─ engine.js       # 快速棋盘 + 启发式走子 + MCTS 搜索
│  ├─ mcts.js         # 多线程并行选点
│  ├─ worker.js       # 搜索线程
│  └─ katago.js       # KataGo GTP 客户端
├─ katago/            # KataGo 引擎 + 模型（由 setup-katago.mjs 生成）
└─ package.json
```

## 工作原理

- 通过逆向 weiqigo.com 的协议实现：REST 认证（`/api/auth/login`、`/api/auth/register`）拿到 JWT，再用 Socket.IO 连接，用 `join-game` / `make-move` / `pass-move` 等事件对局。
- 规则引擎复用了站内开源的 `go-engine.js`（UMD 模块），保证提子、禁着、劫、数子与服务器完全一致。
- 引擎二选一：**KataGo**（GTP 协议，`katago.exe gtp` 子进程，最强）或**自研 MCTS**（UCB1 选点 + 启发式快速模拟 + 多线程根并行，零依赖回退）。

## 许可证与第三方组件

- 本项目代码（`bot.js`、`engine/`、`setup-katago.mjs` 等）以 **MIT** 协议开源，见 [`LICENSE`](./LICENSE)。
- `go-engine.js` 提取自 WeiqiGo.com 的公开前端（未改动），版权归 WeiqiGo.com，仅用于保证规则与服务器一致，不在本仓库 MIT 授权范围内。
- **KataGo** 引擎与神经网络模型由 `setup-katago.mjs` 下载，遵循 KataGo 及其训练社区各自的许可，本仓库不重新分发它们。

## 免责声明

本项目仅供与**知情且同意**的好友在私人房间娱乐对弈。请勿用于公开匹配、排行榜刷分或任何违反平台条款的场景，由此产生的账号风险由使用者自行承担。
