/**
 * NodeLoc · 每日签到，领取能量奖励
 *
 * 目标站：https://www.nodeloc.com
 * （官方文档见 https://docs.nodeloc.com/energy/checkin ：签到按钮在页面
 *  右上角，每天可签一次，签到成功提示 “Check-in successful! You received
 *  N Energy”，已签过显示 “You have already checked in today”。）
 *
 * 原理（按本站网页前端自己的代码，即 /static/app.js 的 api() 与
 *  /static/features.js 的签到逻辑；已用真站请求验证）：
 *   POST /api/v1/auth/login
 *     JSON {login, password, remember: true}
 *     -> 成功：登录态写入 Cookie 会话；失败：{error: {code, message}}
 *        常见 code：invalid_credentials（账号密码不对）、
 *        second_factor_required（开了两步验证）、
 *        email_not_verified（邮箱未验证）、captcha_*（要人机验证）
 *   GET  /api/v1/checkin
 *     -> {checked_in_today: true/false}
 *   POST /api/v1/checkin（带 Idempotency-Key 请求头）
 *     -> {balance, points}，页面提示 “签到成功，+N 能量”
 *   GET  /api/v1/points
 *     -> {balance, ...} 当前能量余额
 *
 * 注意：本站现在用的是自研 /api/v1 接口，不是 Discourse 的 /session、
 * /session/csrf.json、/checkin——那几条在真站上都返回 404，网上的
 * NodeLoc MCP（按 Android App 逆向的 Discourse 流程）已不适用。
 * 登录失败次数多了，服务端会要求人机验证（captcha），Surge 做不了，
 * 只能等一会儿或在浏览器里登录一次。
 * 开了两步验证（TOTP/短信）的账号无法用本模块登录，因为验证码每 30 秒
 * 一变，不能填在模块参数里；请用没开两步验证的账号，或先关掉两步验证。
 * 本站可能有 Cloudflare 拦截，Surge 请求若被拦截会直接报出来，
 * 这种情况模块无解，只能手动在浏览器里签到。
 *
 * 账号填写（三选一，优先 $argument）：
 *   1. Surge 模块参数（推荐）：nodeloc.sgmodule 里用 #!arguments 声明了
 *      username、password，导入模块后在 Surge「编辑参数」里填写，
 *      模块会把它们拼成 argument=username=...&password=... 传给脚本。
 *      用户名或邮箱都可以；密码里有 & 请写成 %26，有 = 请写成 %3D
 *      （脚本会解码回来）。
 *   2. Surge 脚本的 argument 参数（字符串）：
 *        argument=username=你的账号&password=你的密码
 *      或 JSON：
 *        argument={"username":"你的账号","password":"你的密码"}
 *      多账号 JSON：
 *        argument={"accounts":[{"username":"a","password":"p1"},{"username":"b","password":"p2"}]}
 *   3. BoxJS / $persistentStore：
 *        nodeloc_username、nodeloc_password
 *      多账号时在 BoxJS 填 nodeloc_accounts（JSON 数组，同上格式）。
 *
 * 请勿把账号密码发到聊天或公开仓库，只填在 Surge / BoxJS 本地。
 *
 * 签到：cron 每天在模块参数设定的时间自动运行（默认 09:00）。
 * 时间在 nodeloc.sgmodule 的「编辑参数」里改：checkin_hour（0-23，默认 9）、
 * checkin_minute（0-59，默认 0），例如 8 点 30 分就填 8 和 30。结果未确认时请到网站核对。
 *
 * 接口来源：本站网页前端 /static/app.js、/static/features.js、/static/auth.js
 * 本版作者：Muse，Surge / Loon / Quantumult X / Stash 通用脚本。
 *
 * ===== Surge =====
 * [Script]
 * NodeLoc签到 = type=cron,cronexp="0 9 * * *",timeout=60,script-path=https://raw.githubusercontent.com/JiuYueQingCheng/nodeloc-surge-checkin/main/nodeloc.js,argument=username=你的账号&password=你的密码
 * 也可以直接用随附的 nodeloc.sgmodule 导入 Surge（见 README.md）。
 *
 * ===== Loon / Quantumult X / Stash =====
 * Loon 的 $argument 是对象，Quantumult X / Stash 用 BoxJS 填账号，
 * 其余用法与 AgentRouter / MyAPI 模块相同。
 */

const $ = new Env("NodeLoc");

// 签到合集开启「统一通知」时不单独弹通知，结果由签到汇总统一发送
$.merge = typeof $argument === "object" && !!$argument && $argument.merge === true;

if ($.merge) $.msg = (...a) => console.log(a.filter((x) => typeof x === "string" && x).join("\n"));

const SCRIPT_VERSION = "2026-11-25.r2";

$.log(`[INFO] 脚本版本 ${SCRIPT_VERSION}`);

const USER_KEY = "nodeloc_username";
const PASSWORD_KEY = "nodeloc_password";
const ACCOUNTS_KEY = "nodeloc_accounts";
const CLEAR_KEY = "nodeloc_clear";
const DEBUG_KEY = "nodeloc_debug";

const IS_LOON = $.isLoon();

// $argument 在 Surge 里是字符串，在 Loon 里是对象，在 QX/Stash 里不存在。
// 统一解析成对象，解析失败时当作空对象。
const PLUGIN = parseArgument(typeof $argument !== "undefined" ? $argument : null);

const SETTINGS_PAGE = IS_LOON ? "Loon 插件设置或 BoxJS" : "BoxJS / Surge 模块 argument";

const BASE_URL = "https://www.nodeloc.com";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

// Cookie 会话：登录与签到都靠它。Surge 的 $httpClient 默认自动管理
// 同域 Cookie，所以只在非 Surge 下手动带 Cookie 请求头。
let cookieJar = {};

function parseArgument(raw) {
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    if (typeof raw !== "string") return {};
    const text = raw.trim();
    if (!text) return {};
    // JSON：{"username":"...","password":"..."} 或 {"accounts":[...]}
    if (text.startsWith("{")) {
        try { return JSON.parse(text); } catch (_) { return {}; }
    }
    // 查询串：username=...&password=...&debug=true
    const out = {};
    for (const part of text.split("&")) {
        const eq = part.indexOf("=");
        if (eq <= 0) continue;
        const k = decodeURIComponent(part.slice(0, eq).trim());
        const v = decodeURIComponent(part.slice(eq + 1).trim());
        if (k) out[k] = v;
    }
    return out;
}

run().catch((error) => {
    // 只输出脚本主动生成的错误，不转储账号、请求和原始响应。
    saveStatus("fail", error.message);
    $.msg($.name, "❌ 运行失败", error.message);
}).finally(() => $.done());

async function run() {
    const clear = $.getdata(CLEAR_KEY);

    if (clear === "true" || clear === "1") {
        const userCleared = $.setdata("", USER_KEY);
        const passwordCleared = $.setdata("", PASSWORD_KEY);
        if (!userCleared || !passwordCleared) {
            throw new Error("账号信息清除失败，请在 BoxJS 中检查并手动清空");
        }
        $.setdata("false", CLEAR_KEY);
        $.msg($.name, "✅ 账号信息已清除", "需要继续签到时，请在 BoxJS 重新填写账号和密码");
        return;
    }

    const accounts = readAccounts();

    if (!accounts.length) {
        saveStatus("none", "未配置账号");
        $.msg($.name, "🚫 未配置账号", `请在 ${SETTINGS_PAGE} 的 NodeLoc 中分别填写账号和密码并保存`);
        return;
    }

    const results = [];

    for (let i = 0; i < accounts.length; i++) {
        debug(`开始账号 ${i + 1}/${accounts.length}`);
        try {
            results.push(await checkin(accounts[i]));
        } catch (error) {
            results.push({ title: "❌ 运行失败", content: error.message });
        }
    }

    // 登录失败 = 账号密码需要更新，对应体检里的「需重新抓取」
    const loginFailed = results.some((result) => result.title === "❌ 登录失败");
    const failed = results.find((result) => result.title === "❌ 运行失败");

    if (loginFailed) saveStatus("cookie", "登录失败,请检查账号密码");
    else if (failed) saveStatus("fail", failed.content);
    else saveStatus("ok", results.map((result) => result.content.split("\n")[0].replace(/^🎁\s*/, "")).join(" · "), results.length === 1 ? results[0].balance : undefined); // 多账号不合并余额

    if (results.length === 1) {
        $.msg($.name, results[0].title, `👤 账号：${maskAccount(accounts[0].username)}\n${results[0].content}`);
    } else {
        $.msg($.name, `签到汇总（${results.length} 个账号）`, results.map((result, i) =>
            `👤 账号 ${i + 1} · ${maskAccount(accounts[i].username)}\n${result.title}\n${result.content}`).join("\n\n"));
    }
}

function readAccounts() {
    // 1. $argument（Surge 字符串 / Loon 对象）里的多账号
    const multi = PLUGIN.accounts;
    if (multi) {
        let accounts;
        if (typeof multi === "string") {
            try { accounts = JSON.parse(multi); } catch (_) {
                throw new Error("多账号格式错误，请按使用说明填写 JSON 数组");
            }
        } else {
            accounts = multi;
        }
        if (!Array.isArray(accounts) || !accounts.length) {
            throw new Error("多账号必须是非空 JSON 数组；使用单账号时请清空多账号输入框");
        }
        return accounts.map((account, i) => {
            if (!account || typeof account.username !== "string" || !account.username.trim()
                || typeof account.password !== "string" || !account.password) {
                throw new Error(`多账号第 ${i + 1} 项缺少有效的 username 或 password，请检查插件设置`);
            }
            return { username: account.username.trim(), password: account.password };
        });
    }

    // 2. BoxJS 里存的多账号
    const storedMulti = $.getdata(ACCOUNTS_KEY);
    if (storedMulti) {
        try {
            const accounts = JSON.parse(storedMulti);
            if (Array.isArray(accounts) && accounts.length) {
                return accounts.map((account, i) => {
                    if (!account || typeof account.username !== "string" || !account.username.trim()
                        || typeof account.password !== "string" || !account.password) {
                        throw new Error(`多账号第 ${i + 1} 项缺少有效的 username 或 password`);
                    }
                    return { username: account.username.trim(), password: account.password };
                });
            }
        } catch (e) {
            if (e.message && e.message.includes("多账号第")) throw e;
            throw new Error("BoxJS 多账号格式错误，请填写 JSON 数组");
        }
    }

    // 3. 单账号：$argument 优先，其次 BoxJS / $persistentStore
    const username = (PLUGIN.username || $.getdata(USER_KEY) || "").trim();
    const password = PLUGIN.password || $.getdata(PASSWORD_KEY) || "";

    return username && password ? [{ username, password }] : [];
}

function uuid() {
    // Math.random 版 UUID v4，不依赖 crypto 接口。
    const hex = "0123456789abcdef";
    const pick = () => hex[Math.floor(Math.random() * 16)];
    let s = "";
    for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) s += "-";
        else if (i === 14) s += "4";
        else if (i === 19) s += hex[8 + Math.floor(Math.random() * 4)];
        else s += pick();
    }
    return s;
}

function storeCookies(headers) {
    const key = Object.keys(headers).find((name) => name.toLowerCase() === "set-cookie");
    if (!key) return;
    const raw = [].concat(headers[key]).join("\n");
    // 每行一个 Set-Cookie；跳过 Expires/Path/Domain 等属性，只收 Cookie 名值对。
    const skip = /^(expires|path|domain|max-age|secure|httponly|samesite)$/i;
    const re = /(?:^|[\n,])\s*([A-Za-z0-9_!#$%&'*+\-.^`|~]+)=([^;,\s]+)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        if (!skip.test(m[1])) cookieJar[m[1]] = m[2];
    }
}

function cookieHeader() {
    return Object.keys(cookieJar).map((k) => `${k}=${cookieJar[k]}`).join("; ");
}

function apiHeaders(extra) {
    const headers = {
        "User-Agent": UA,
        Accept: "application/json",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
    };
    if (!$.isSurge()) {
        const cookie = cookieHeader();
        if (cookie) headers["Cookie"] = cookie;
    }
    return Object.assign(headers, extra || {});
}

function apiError(data) {
    if (!data || typeof data !== "object") return { code: "", message: "" };
    const err = data.error && typeof data.error === "object" ? data.error : data;
    return {
        code: typeof err.code === "string" ? err.code : "",
        message: typeof err.message === "string" ? err.message : (typeof data.message === "string" ? data.message : ""),
    };
}

async function checkin({ username, password }) {
    cookieJar = {};
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

    // 1. 登录
    let login;
    try {
        login = await request("POST", "/api/v1/auth/login",
            apiHeaders({ "Content-Type": "application/json" }),
            JSON.stringify({ login: username, password, remember: true }),
            "登录");
    } catch (error) {
        return { title: "❌ 登录失败", content: `请先在 NodeLoc 网页确认账号、密码是否正确，再更新 ${SETTINGS_PAGE}\n${error.message}` };
    }

    if (login.status >= 400 || (login.json && login.json.error)) {
        const err = apiError(login.json);
        if (err.code === "second_factor_required") {
            return { title: "❌ 登录失败", content: "账号开启了两步验证，Surge 无法自动填验证码，请用没开两步验证的账号，或先在网站关掉两步验证" };
        }
        if (err.code === "email_not_verified") {
            return { title: "❌ 登录失败", content: "账号邮箱未验证，请先在网站完成邮箱验证再签到" };
        }
        if (err.code && err.code.indexOf("captcha") === 0) {
            return { title: "❌ 登录失败", content: "登录失败次数多了，服务端要求人机验证，Surge 做不了，请在浏览器里登录一次再试" };
        }
        return { title: "❌ 登录失败", content: `请先在 NodeLoc 网页确认账号、密码是否正确，再更新 ${SETTINGS_PAGE}${err.message ? `\n${err.message}` : ""}` };
    }
    debug(`登录成功；Cookie：${Object.keys(cookieJar).join(",") || "无（Surge 自动管理）"}`);

    // 2. 查今日签到状态
    let statusRes;
    try {
        statusRes = await request("GET", "/api/v1/checkin", apiHeaders(), undefined, "签到状态查询");
    } catch (error) {
        return { title: "⚠️ 签到待确认", content: `🎁 签到奖励：待确认\n\n签到状态查询失败\n${error.message}` };
    }

    // 3. 查能量余额（失败不拦签到）
    let balance;
    let stats = "";
    try {
        const points = await request("GET", "/api/v1/points", apiHeaders(), undefined, "能量查询");
        if (points.json && typeof points.json.balance === "number" && Number.isFinite(points.json.balance)) {
            balance = `能量 ${points.json.balance}`;
            stats = `⚡ 当前能量：${points.json.balance}`;
        }
    } catch (error) {
        debug(`能量查询失败：${error.message}`);
    }

    if (statusRes.json && statusRes.json.checked_in_today === true) {
        return { title: "✅ 今日签到已确认", content: `🎁 今日奖励：今日已签到\n${stats}\n🕒 签到日期：${today}（今日已签到）`, balance };
    }

    // 4. 未签到：POST 签到
    let doRes;
    try {
        doRes = await request("POST", "/api/v1/checkin",
            apiHeaders({ "Idempotency-Key": uuid() }),
            undefined,
            "签到");
    } catch (error) {
        return { title: "⚠️ 签到待确认", content: `🎁 签到奖励：待确认\n${stats}\n\n签到请求失败\n${error.message}`, balance };
    }

    if (doRes.status >= 400 || (doRes.json && doRes.json.error)) {
        const err = apiError(doRes.json);
        if (/already checked in|已经签到|今日已签/i.test(`${err.code} ${err.message}`)) {
            return { title: "✅ 今日签到已确认", content: `🎁 今日奖励：今日已签到\n${stats}\n🕒 签到日期：${today}（今日已签到）`, balance };
        }
        return { title: "⚠️ 签到待确认", content: `🎁 签到奖励：待确认\n${stats}\n\n签到未成功：${err.message || "请到网站核对"}`, balance };
    }

    const points = doRes.json && typeof doRes.json.points === "number" ? doRes.json.points : null;
    const newBalance = doRes.json && typeof doRes.json.balance === "number" ? doRes.json.balance : null;
    if (newBalance !== null) {
        balance = `能量 ${newBalance}`;
        stats = `⚡ 当前能量：${newBalance}`;
    }
    const reward = points !== null
        ? `🎁 本次奖励：+${points} 能量`
        : "🎁 本次奖励：签到成功（金额未识别，请到网站核对）";
    return { title: "✅ 今日签到已确认", content: `${reward}\n${stats}\n🕒 签到日期：${today}`, balance };
}

// 记录本次结果，供「签到汇总」：ok 正常 / cookie 需重新抓取 / fail 其他失败 / none 未使用
function saveStatus(s, msg, asset) {
    msg = String(msg).slice(0, 100);

    // 服务器明确提示登录过期的失败，按需要重新抓取处理
    if (s === "fail" && /过期|重新登录|未登录|请登录|登录失效|登录已失效|token\s*(失效|过期|无效)|not\s*login/i.test(msg)) s = "cookie";

    // 同一天已有带奖励的成功记录时，再次运行得到的「今日已签」不覆盖它的奖励文字，只合并本次的资产等信息
    let keep = null;

    if (s === "ok" && /^今日已/.test(msg)) {
        const day = (t) => new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
        let old = null;
        try { old = JSON.parse($.getdata("nodeloc_status") || "null"); } catch (e) {}
        if (old && old.s === "ok" && !/^今日已/.test(old.msg) && day(old.t) === day(Date.now())) keep = old;
    }

    checkinReport("nodeloc_status", keep ? keepReward(keep, { s, msg, asset }) : { s, msg, asset }, { name: "NodeLoc", author: "Muse" });
}

function maskAccount(username) {
    const name = username.split("@")[0];
    return name.length > 4 ? `${name.slice(0, 2)}***${name.slice(-2)}` : `${name.slice(0, 1)}***`;
}

function request(method, path, headers, body, label) {
    return new Promise((resolve, reject) => {
        const options = { url: BASE_URL + path, headers };
        if (body !== undefined) options.body = body;

        // 账号密码只发给固定 HTTPS 站点；Loon 默认允许不受信任证书，需显式关闭。
        if ($.isLoon()) {
            options.insecure = false;
            options["auto-redirect"] = false;
            // 每个账号只使用本次登录拿到的 session，禁止 Cookie 自动沿用到下一个账号。
            options["auto-cookie"] = false;
        }

        $.send(options, method, (error, response, text) => {
            if (error) {
                reject(new Error(`${label}网络请求失败，请检查该网站的 Surge 分流或稍后重试`));
                return;
            }

            const status = Number(response && (response.status || response.statusCode));
            debug(`${label} HTTP ${status}`);

            if (typeof text === "string" && /cloudflare|attention required|cf-mitigated/i.test(text.slice(0, 500)) && status === 403) {
                reject(new Error(`${label}被 Cloudflare 拦截（403），请手动在浏览器里签到`));
                return;
            }

            if (status < 200 || status >= 300 || !status) {
                // 登录、签到接口用 {error:{code,message}} 返回 4xx，调用方按业务错误处理，
                // 所以这里把 JSON 错误体也带回去，而不是直接丢掉。
                let json = null;
                try { json = JSON.parse(text); } catch (_) {}
                if (json && typeof json === "object" && json.error) {
                    storeCookies(response.headers || {});
                    resolve({ json, status, headers: response.headers || {} });
                    return;
                }
                reject(new Error(`${label}返回 HTTP ${status || "未知"}，请在浏览器确认网站是否可访问或需要验证`));
                return;
            }

            let json = null;
            try {
                json = JSON.parse(text);
            } catch (_) {
                reject(new Error(`${label}返回非 JSON 内容，可能是网页验证或服务异常，请到网站检查`));
                return;
            }

            if (!json || typeof json !== "object" || Array.isArray(json)) {
                reject(new Error(`${label}响应格式异常，请到网站检查`));
                return;
            }

            storeCookies(response.headers || {});
            resolve({ json, status, headers: response.headers || {} });
        });
    });
}

function debug(message) {
    if (PLUGIN.debug === true || PLUGIN.debug === "true" || $.getdata(DEBUG_KEY) === "true") $.log(`[DEBUG] ${message}`);
}

// 保留当天带奖励的旧记录（状态、奖励文字、时间），合并本次拿到的资产、过期时间等；本次没有的沿用旧值
function keepReward(old, rec) {
    const out = { s: old.s, msg: old.msg, t: old.t, asset: old.asset, exp: old.exp };
    for (const k in rec) if (rec[k] !== undefined && k !== "s" && k !== "msg") out[k] = rec[k];
    return out;
}

// 签到状态协议 v1：写本次结果，并把自己登记进公共索引 checkin_registry（Loon/Surge/QX/Stash 通用，不依赖 Env）
function checkinReport(key, rec, info) {
    const read = (k) => (typeof $prefs !== "undefined" ? $prefs.valueForKey(k) : $persistentStore.read(k));
    const write = (v, k) => (typeof $prefs !== "undefined" ? $prefs.setValueForKey(v, k) : $persistentStore.write(v, k));
    const registry = () => { try { return JSON.parse(read("checkin_registry") || "{}") || {}; } catch (e) { return {}; } };
    write(JSON.stringify(Object.assign({ v: 1, t: Date.now(), name: info.name, author: info.author }, rec)), key);
    const reg = registry();
    if (JSON.stringify(reg[key]) === JSON.stringify(info)) return;
    reg[key] = info;
    write(JSON.stringify(reg), "checkin_registry");
    if (!registry()[key]) console.log(`[checkin] ${key} 登记没写上，下次运行再补`);
}

function Env(s) {
    this.name = s;
    this.isSurge = () => typeof $httpClient !== "undefined";
    this.isQuanX = () => typeof $task !== "undefined";
    this.isLoon = () => typeof $loon !== "undefined";
    this.log = (...a) => console.log(a.join("\n"));
    this.msg = (t = this.name, s = "", b = "") => {
        if (this.isSurge() || this.isLoon()) $notification.post(t, s, b);
        else if (this.isQuanX()) $notify(t, s, b);
        console.log(["", `====📣${t}====`, s, b].filter(Boolean).join("\n"));
    };
    this.getdata = (k) => {
        if (this.isSurge() || this.isLoon()) return $persistentStore.read(k);
        if (this.isQuanX()) return $prefs.valueForKey(k);
        return null;
    };
    this.setdata = (v, k) => {
        if (this.isSurge() || this.isLoon()) return $persistentStore.write(v, k);
        if (this.isQuanX()) return $prefs.setValueForKey(v, k);
        return false;
    };
    this.send = (req, method, cb) => {
        if (this.isSurge() || this.isLoon()) {
            const fn = method === "POST" ? $httpClient.post : $httpClient.get;
            fn(req, (err, resp, data) => {
                if (resp) {
                    resp.body = data;
                    resp.statusCode = resp.status || resp.statusCode;
                }
                cb(err, resp, data);
            });
        } else if (this.isQuanX()) {
            req.method = method;
            $task.fetch(req).then(
                (r) => {
                    r.status = r.statusCode;
                    cb(null, r, r.body);
                },
                (e) => cb(e.error || e, null, null),
            );
        }
    };
    this.done = (v = {}) => {
        if (typeof $done !== "undefined") $done(v);
    };
}
