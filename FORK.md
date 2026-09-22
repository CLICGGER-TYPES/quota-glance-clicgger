# Quota Glance Clicgger(个人 fork)

- 上游:`https://github.com/Geequlim/quota-glance`(remote 名 `upstream`)
- 本仓库:`https://github.com/CLICGGER-TYPES/quota-glance-clicgger`(remote 名 `origin`)
- 本 fork 在上游基础上加了 **Claude 渠道**、**代理设置**、**顶栏位置**、**网络失败短延时重试**,其余代码与上游保持一致,方便 `git rebase` 跟进
- 身份:
  - 显示名 `Quota Glance Clicgger`
  - UUID `quota-glance-clicgger@clicgger.github.io`
  - schema `org.gnome.shell.extensions.quota-glance-clicgger`,dconf 路径 `/org/gnome/shell/extensions/quota-glance-clicgger/`

> 从上游 UUID(`quota-glance@geequlim`)改名过一次。改名后**不再盖住** AUR / 发行版装的那份:
> 两份是不同 UUID 的独立扩展,旧那份必须卸掉或禁用,否则面板上会出现两个图标。
> 旧 dconf 设置已用 `dconf dump | dconf load` 搬过来(见下面「改名迁移」)。

## 新增/改动的文件

| 文件 | 作用 |
|---|---|
| `src/providers/claude/provider.ts` | 渠道实现:读凭证 → 打用量接口 → 401/403 时让 CLI 续期一次 → 重试;面板只显示本周剩余一个数 |
| `src/core/controller.ts` | 网络类失败(`http` / `timeout`)的短延时重试阶梯 10s → 30s → 90s |
| `src/host/panel-target.ts`、`src/extension.ts`、`src/prefs.ts`、`schemas/*.gschema.xml` | 新增 `panel-position` 设置(左/中/右),默认**左侧** |
| `src/runtime/proxy-settings.ts`、`src/runtime/http-client.ts`、`src/prefs.ts` | 首选项里的代理设置，覆盖环境变量，改完即时生效 |
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
gnome-extensions install --force artifacts/quota-glance-clicgger@clicgger.github.io.shell-extension.zip
# 首次装到用户目录,GNOME Shell 不热加载:注销重登一次
gnome-extensions info quota-glance-clicgger@clicgger.github.io        # 确认 Path 指向 ~/.local/share/...
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

## 面板位置

默认放在 **GNOME 顶栏左侧**。索引算法照搬官方 `gnome-shell-extensions` 里 places-menu 的写法:

```ts
pos = Main.sessionMode.panel.left.length        // 默认模式是 ['activities'] → 1
    + ('apps-menu' in Main.panel.statusArea ? 1 : 0);
Main.panel.addToStatusArea(uuid, indicator, pos, 'left');
```

所以它排在「活动」按钮**右侧**、其他左侧项目之后,不会跑到状态区(右侧那堆)里去。

设置里多了一个「顶栏位置:左侧 / 中间 / 右侧」(schema 键 `panel-position`),**改完立即生效,不用重登** ——
`changed::panel-position` 会重新挂载指示器。Dash to Panel 那边固定进中间任务栏区,不受这个设置影响。

## 代理设置

首选项里有「代理」一组，两个可编辑项：

- **代理地址**（`proxy-url`）—— 例如 `http://127.0.0.1:2080`，会同时写入 `HTTP_PROXY` / `HTTPS_PROXY` / 小写两个
- **不走代理的地址**（`proxy-no-proxy`）—— 默认 `localhost,127.0.0.1,::1`

行为：

- 留空 = **沿用环境里的代理**（`/etc/environment`、`~/.config/environment.d/*.conf`、`~/.config/quota-glance/env`）
- 填上 = 覆盖上面那四个键；再清空会回退到环境值（实现是先把 6 个代理变量恢复成 base 再覆盖）
- **即时生效**：改动就地修改共享的 environment 对象，`HttpClient.updateProxy()` 重建 resolver 并立即重新取数；
  同一个对象也让 spawn 出的命令（`command-runner`、Claude 续期）同步生效，所以**不用重登**
- 输入按回车 / 点应用按钮后才提交，不会每敲一个字触发一次请求

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

## 改代码的代价

GNOME Shell **不能热重载扩展代码**:`extensionSystem.js:501` 是 `await import(extensionJs.get_uri())`,
import specifier 不带版本参数 → 模块缓存命中,`disable` + `enable` 只是重跑旧对象的 `enable()`。
图标另有 St 纹理缓存(路径 + 前景色 + 尺寸为 key)。
**所以改完 JS / 图标后必须注销重登**;判断文件是否已更新要看 `md5sum`,不能看面板表现。
唯一不需要重登的是**设置项** —— 设置是运行时读的,`changed::<key>` 直接触发重新挂载或重新取数。

## 改名迁移(一次性)

```bash
# 1) 备份旧设置并搬到新路径
dconf dump /org/gnome/shell/extensions/quota-glance/ > old.dump
dconf load /org/gnome/shell/extensions/quota-glance-clicgger/ < old.dump

# 2) 换 enabled-extensions:去掉旧 UUID、加上新 UUID
# 3) 卸掉旧的用户目录副本(如果装过)
gnome-extensions uninstall quota-glance@geequlim
# 4) 发行版/AUR 装的那份建议直接卸掉:sudo pacman -R gnome-shell-extension-quota-glance
# 5) 装新 UUID 后注销重登(新 UUID 必须让 Shell 重新扫描)
```

## 已知限制

- 面板只显示本周剩余(与 Codex 一致),5 小时窗口只在点开菜单里看;想换成会话窗口改 `provider.ts` 的 `getPanelItems` 一行即可。
- 左侧位置的三档设置生效不需要重登,但**改动代码后必须注销重登**(见下面「改代码的代价」)。
- 只处理「会话 + 每周 + 模型级」三类窗口;`seven_day_breakdown`(Claude Code / Chats / Cowork 用量占比)与 `spend`(额外额度)暂未展示。
- 模型级窗口若只出现在顶层键而没有 `limits[]` 条目,名称由键名推导(`seven_day_sonnet` → `Sonnet`),不是 Anthropic 的 display_name。
- 续期依赖本机 `claude` CLI;没有它只能等 Claude Code 自己刷新 token。
