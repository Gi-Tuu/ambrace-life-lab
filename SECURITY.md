# 安全说明

## 报告漏洞

这是一个单人演示项目，没有安全响应团队。请通过 `README.md`「反馈」一节的渠道联系作者，
不要开公开 issue 描述可利用细节。作者会尽力在下一个版本修掉。

## 部署时的已知要求（不照做会出问题）

这个服务**默认是本地演示姿态**，直接暴露到公网前必须显式配置：

| 配置 | 不配的后果 |
|---|---|
| `CTL_TOKEN` | 两种姿态，**按是否配置区分**：①**不配（生产默认）**——普通交互仍按同源/loopback 守卫；`/ctl` 的破坏性动作（`reset` / `survival_reset` / `catchup` / `brain` / `compare_reset`）必须出示**服务端签发的会话 + nonce**（`ctl_sid` HttpOnly + `ctl_nonce`，SameSite=Strict，服务端按 sid 存储并校验；nonce 一次性、60s TTL）。`Origin` / `sec-fetch-site` / `x-forwarded-host` 都是请求方可伪造的头，**不再单独作为授权证据**；②**配了**——普通交互（`/act`、`/saves/open`、`/saves/back`）仍允许同源浏览器通过，破坏性 `/ctl` **只认** `authorization: Bearer <token>` 或 `x-ctl-token`。**唯一例外**：MAIN 的 `survival_reset` 允许“服务端会话 nonce”（一次性 + 60s TTL + 全局 3 次/分钟 + `[audit] main_reset` 审计事件），用于浏览器“新开一局”；全局 reset/具名营地不受此例外影响。公开部署建议设，令牌只进密文变量 |
| `CHAT_TOKEN` | `/chat` 转发默认**关闭**（返回 404）。不设就没人能用它烧你的模型额度（这是有意的默认） |
| `MAX_CALLS` | 每日模型调用额度。不设默认 120；公开实例建议按预算设小 |
| `PRESENCE_MS` | 无人观看时停调真模型的窗口。**单位是毫秒**：想 60 秒要写 `60000`，写 `60` 只有 60 毫秒 |

其它已内置的防护：静态面白名单 + realpath（**只放 `/web/` 与 `/shared/`**；`shared/` 只允许纯数据/几何，
不得放服务端逻辑或秘密）、`/healthz` 不回显密钥/端点/数据目录、请求体上限 64 KB、畸形 URL 与未捕获异常不会杀进程、
`world.json` 原子写 + `.bak` 轮转、CSP `default-src 'self'` + `frame-ancestors 'self' https://*.ms.show
https://modelscope.cn https://www.modelscope.cn`（平台要嵌 iframe，所以**不设** `X-Frame-Options`）+ `X-Content-Type-Options: nosniff`
、存档错误只回错误码（不回显绝对路径）、HTTPS 部署时 cookie 带 `Secure`
（可用 `COOKIE_SECURE=1` 强制）。

**营地归属（SEC5-02 / DATA5-05）**：创建营地时下发 `camp_owner`（HttpOnly cookie），索引里只存它的 sha256（`ownerHash`），
并原子写入侧车 `saves/<key>.owner.json`（name + ownerHash）。**所有非 MAIN 的 `/world` 读路径都要求匹配的
`camp_owner`**；没有 owner cookie 一律 403。已有 owner 的营地重开时不会换绑、也不会给非 owner 发新 cookie
（返回 `CAMP_OWNED`）。索引整体丢失且无 corrupt 备份时，启动会从营地档 + 侧车重建索引并恢复 owner/名字；
没有侧车的旧营地保持“首次 claim”兼容。MAIN 的 `survival_reset` 在未设令牌时由服务端会话 nonce 授权，
设令牌时走上面的唯一例外。key 是名字的 sha256，但它是**定位符不是凭据**；知道 key 也读不到世界。

**持久化窗口**：启动会写一次基线档（主档可直接载入时不重写），`flushWrites`/SIGTERM 会收口；
硬杀进程仍可能丢 ≤`SAVE_EVERY` 刻（默认 10，可用 `SAVE_EVERY` 调小）。不做 WAL 就没有零丢失保证。

## 不在范围内

- 多租户与账号体系：本项目没有用户概念，玩家是单实例里的一个全知观察者。
- 密钥管理：密钥只从环境变量读，不进前端、不进镜像、不进仓库。
