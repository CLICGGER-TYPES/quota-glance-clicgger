# Quota Glance(claude fork)

上游:`https://github.com/Geequlim/quota-glance`(本仓库的 `origin`)
本 fork 只做一件事:**给 Quota Glance 加一个 Claude 渠道**,其余代码与上游保持一致,方便日后 `git rebase` 跟进。

- 版本号:`1.0.2+claude.1`(package.json / package-lock.json / metadata.json 三处一致)
- UUID 仍是 `quota-glance@geequlim`:GNOME Shell 扫描扩展时**用户目录优先**(`fileUtils.js` 里 `dataDirs.unshift(get_user_data_dir())`,重名时后者跳过),所以装到
  `~/.local/share/gnome-shell/extensions/quota-glance@geequlim/` 的这份会**盖住**系统包(`/usr/share/...`)那份,不需要先卸 AUR 包。

## 新增/改动的文件

| 文件 | 作用 |
|---|---|
| `src/providers/claude/provider.ts` | 渠道实现:读凭证 → 打用量接口 → 401/403 时让 CLI 续期一次 → 重试;面板只显示本周剩余一个数 |
| `src/core/controller.ts` | 网络类失败(`http` / `timeout`)的短延时重试阶梯 10s → 30s → 90s |
| `src/providers/claude/parser.ts` | 用量报文归一化(`limits[]` 与旧版顶层窗口两种形态) |
| `src/runtime/claude-credentials.ts` | 只读 `~/.claude/.credentials.json`(每次 collect 重新读,CLI 轮换的 token 自动生效) |
| `src/runtime/claude-auth.ts` | 续期:spawn `claude auth login --claudeai`,refresh token 走环境变量,45s 超时 |
| `icons/claude-symbolic.svg` | 面板/首选项图标 |
| `src/providers/index.ts`、`src/shared/provider-catalog.ts`、`src/shared/i18n/{en,zh-cn}.ts` | 注册渠道、首选项条目、文案 |
| `tests/provider-parsers.test.mjs`、`tests/fixtures/claude-usage.json` | 5 个解析单测 |
| `tests/refresh-retry-smoke.js` | gjs 重试链路实测(失败 → 短延时重试 → 成功;不无限重试) |
| `scripts/package.mjs` | 打包完整性校验加上 claude 相关文件 |

## 工作原理

```
~/.claude/.credentials.json   (Claude Code 拥有,本扩展只读)
        │ claudeAiOauth.accessToken / refreshToken / subscriptionType / rateLimitTier
        ▼
ClaudeProvider.collect()
        │  GET https://api.anthropic.com/api/oauth/usage
        │  Authorization: Bearer <accessToken>
        │  anthropic-beta: oauth-2025-04-20
        ▼
parseClaudeUsageResponse()  →  five_hour / seven_day / 模型级窗口
        │
        └─ HTTP 401/403 → ClaudeAuth.renew() 让 claude CLI 续期 → 重读凭证 → 重试一次
```

要点与坑:

- **该接口 Anthropic 未公开文档**,基于 Claude Code `/usage` 屏幕所用端点,服务端改动可能让它失效。
- **必须走代理**:直连 `api.anthropic.com` 返回 403(`Request not allowed`),本机实测经 `http://127.0.0.1:2080` 才返回 200。
  扩展本身不读 GNOME 系统代理,代理只能从环境变量给(`~/.config/quota-glance/env`,见下)。
- **登录竞态**:GNOME Shell 起来后 1 秒就发起首次刷新,而本机 v2rayN/xray 是会话自动启动的(实测 shell 20:07:56 → v2rayN 20:08:00 → xray 20:08:03),
  首刷必然连接被拒、面板挂出「网络请求失败」。`RefreshController` 现在对 `http` / `timeout` 类失败补三次短延时重试(10s/30s/90s),
  成功一次即清零;重试用尽后交给原有的周期性刷新(默认 5 分钟)。面板里的「刷新」按钮随时手动重试。
- 续期 spawn 的 `claude` 子进程必须继承同一套代理变量,否则续期同样被 403 —— `claude-auth.ts` 里显式把
  `PATH` / `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 传给了子进程。
- 旧版顶层窗口键(`five_hour_*`、`seven_day_*`)与新 `limits[]` 数组都支持;`limits[]` 里 `weekly_scoped` +
  `scope.model.display_name` 会生成模型级窗口,`0%` 且无重置时间的占位窗口会被丢弃(例如 `nimbus_quill`)。

## 安装

```bash
cd upstream
npm ci --registry=https://registry.npmmirror.com   # 本机 npm 12:registry 必须与 lockfile 里的 mirror 一致,否则 EALLOWREMOTE
npm run typecheck && npm run lint && npm test
npm run package                                    # 产出 artifacts/*.zip
gnome-extensions install --force artifacts/quota-glance@geequlim.shell-extension.zip
# 首次装到用户目录,GNOME Shell 不热加载:注销重登一次
gnome-extensions info quota-glance@geequlim        # 确认 Path 指向 ~/.local/share/...
```

重登后别忘了在扩展设置里勾上 **Claude**(`enabled-providers` 是独立设置项,不会自动加)。

## 验证

```bash
npm run test:providers:live     # 真读凭证 + 真打接口(需要代理已在 env 里);claude 应输出 success
```

`../scratch/verify-claude-provider.mjs`(工作目录内,不在仓库里)会打印解析结果、面板文本和弹出菜单内容:

```bash
gjs -m ../scratch/verify-claude-provider.mjs
# planLabel = Pro
#   five_hour | kind=session | 已用=20% 剩余=80%
#   seven_day  | kind=weekly  | 已用=62% 剩余=38%
# 面板项 = 38%          ← 只显示本周剩余,和 Codex 一个风格
# 弹出菜单里两条进度条都在
```

## 依赖的环境变量

扩展只认 `~/.config/quota-glance/env`(优先级最高)与 `/etc/environment`、`~/.config/environment.d/*.conf`、会话环境:

```
DEEPSEEK_API_KEY=...                   # 原有渠道,与本 fork 无关
HTTP_PROXY=http://127.0.0.1:2080       # Claude 必需
HTTPS_PROXY=http://127.0.0.1:2080
NO_PROXY=localhost,127.0.0.1,::1
```

改完必须把扩展关一次再开(env 只在 `enable()` 时读)。

## 跟进上游

```bash
cd upstream
git fetch origin                      # origin = Geequlim/quota-glance
git rebase origin/main                # 冲突一般只落在 index.ts / provider-catalog.ts / i18n / package.mjs / metadata.json
npm ci --registry=https://registry.npmmirror.com && npm test
```

## 已知限制

- 面板只显示本周剩余(与 Codex 一致),5 小时窗口只在点开菜单里看;想换成会话窗口改 `provider.ts` 的 `getPanelItems` 一行即可。
- 只处理「会话 + 每周 + 模型级」三类窗口;`seven_day_breakdown`(Claude Code / Chats / Cowork 用量占比)与 `spend`(额外额度)暂未展示。
- 模型级窗口若只出现在顶层键而没有 `limits[]` 条目,名称由键名推导(`seven_day_sonnet` → `Sonnet`),不是 Anthropic 的 display_name。
- 续期依赖本机 `claude` CLI;没有它只能等 Claude Code 自己刷新 token。
