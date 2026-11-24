# NodeLoc Surge 每日签到模块

NodeLoc（https://www.nodeloc.com）每日签到模块：每天签到一次领**能量**奖励（官方文档：“Check-in successful! You received N Energy”，已签过显示 “You have already checked in today”；能量可用于打赏、红包、抽奖、付费内容等）。

## 安装

1. 在 Surge 里打开模块安装链接：

   ```
   https://raw.githubusercontent.com/JiuYueQingCheng/nodeloc-surge-checkin/main/nodeloc.sgmodule
   ```

2. 导入后在模块的「编辑参数」里填写：

   - `username`：NodeLoc 用户名或邮箱
   - `password`：NodeLoc 密码
   - `checkin_hour`：每天签到小时（0-23，默认 9）
   - `checkin_minute`：每天签到分钟（0-59，默认 0）

   例如每天 8 点 30 分签到，就填 `checkin_hour=8`、`checkin_minute=30`。

3. Surge 会在设定时间每天自动运行一次。想手动跑一次：Surge → 模块 → NodeLoc 签到 → 运行脚本（或在脚本页面手动触发）。

## 账号说明（重要）

- **两步验证**：开了两步验证（TOTP/短信）的账号无法用本模块登录，因为验证码每 30 秒一变，不能填在模块参数里。请用没开两步验证的账号，或先在网站关掉两步验证。
- 密码里有 `&` 请写成 `%26`，有 `=` 请写成 `%3D`（脚本会解码回来）。
- 请勿把账号密码发到聊天或公开仓库，只填在 Surge 本地。

## 运行结果

| 通知标题 | 含义 |
|---|---|
| ✅ 今日签到已确认 | 签到成功，显示本次/今日奖励（+N 能量）与当前能量余额 |
| ⚠️ 签到待确认 | 登录成功但签到没确认，或余额查询失败——请到网站核对能量历史 |
| ❌ 登录失败 | 账号或密码不对，或账号开了两步验证——请先在网页确认再更新模块参数 |
| 🚫 未配置账号 | 模块参数里没填账号密码 |

## 原理

NodeLoc 现在用的是自研 `/api/v1` 接口（按本站网页前端 `/static/app.js`、`features.js`、`auth.js` 实现，真站请求已验证）：

| 步骤 | 请求 |
|---|---|
| 登录 | `POST /api/v1/auth/login`（JSON `{login, password, remember: true}`）→ 成功后登录态写入 Cookie 会话；失败返回 `{error: {code, message}}`，如 `invalid_credentials`（账号密码不对）、`second_factor_required`（开了两步验证）、`email_not_verified`（邮箱未验证） |
| 查今日签到状态 | `GET /api/v1/checkin` → `{checked_in_today: true/false}` |
| 签到 | `POST /api/v1/checkin`（带 `Idempotency-Key` 请求头）→ `{balance, points}`，页面提示“签到成功，+N 能量” |
| 查能量余额 | `GET /api/v1/points` → `{balance, ...}` |

流程：登录 → 查今日签到状态 → 查能量余额 → 未签到则 POST 签到。今天已签到过时不重复 POST，直接确认。

重要更正：网上的 NodeLoc MCP 是按 Android App 逆向的 Discourse 流程（`GET /session/csrf.json` → `POST /session` → `POST /checkin` 带 nonce/时间戳），但那几条接口在真站上都返回 404——本站网页端已经不用 Discourse 那套了，v1 版本的脚本按它写才会在第一步就失败。v2 改成了上面这套 `/api/v1` 流程。

## 文件

| 文件 | 说明 |
|---|---|
| `nodeloc.js` | 签到脚本（Surge / Loon / Quantumult X / Stash 通用） |
| `nodeloc.sgmodule` | Surge 模块（cron + 模块参数） |
| `README.md` | 本说明 |

## 来源

接口实现按本站网页前端代码（`/static/app.js` 的 `api()`、`features.js` 的签到逻辑、`auth.js` 的登录逻辑），并用真站请求验证了登录失败与未登录时的返回格式：

- 每日签到：https://docs.nodeloc.com/energy/checkin
- 能量系统：https://docs.nodeloc.com/energy/points

## 未验证的部分（实话）

- **真实账号的完整链路**：登录失败分支已用真站假账号验证（`invalid_credentials`，正确报“登录失败”）；签到成功分支用模拟的 `/api/v1` 响应做了两轮测试——本次签到成功（返回 `{points: 10, balance: 510}`）、今天已签到过（`checked_in_today: true`）——都通过了。但没有真实账号，无法在 NodeLoc 真站上跑通登录成功后的完整链路。第一次用真账号跑如果显示“待确认”，请把通知原文发我，我再改。
- **登录后的人机验证**：前端代码写明登录失败次数多了，服务端会要求人机验证（captcha），Surge 做不了；第一次登录用的如果是正确密码，一般不会触发。
- **Cloudflare 拦截**：本站可能对自动化请求做 Cloudflare 拦截，脚本遇到 403 拦截页会直接报出来，这种情况模块无解，只能手动在浏览器里签到。
