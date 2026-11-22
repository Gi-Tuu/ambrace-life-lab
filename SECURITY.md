# 安全说明

## 报告漏洞

这是一个单人演示项目，没有安全响应团队。请通过 `README.md`「反馈」一节的渠道联系作者，
不要开公开 issue 描述可利用细节。作者会尽力在下一个版本修掉。

## 部署时的已知要求（不照做会出问题）

以下是 main `709f02b` 的代码边界，不是线上配置证明。服务默认适合本地演示；公开部署前应审查令牌、预算与持久化配置：

| 配置 | 不配的后果 |
|---|---|
| `CTL_TOKEN` | 两种姿态，**按是否配置区分**：①**不配（代码默认）**——普通交互仍按同源/loopback 守卫；`/ctl` 的破坏性动作（`reset` / `survival_reset` / `catchup` / `brain` / `compare_reset`）必须出示**服务端签发的会话 + nonce**（`ctl_sid` HttpOnly + `ctl_nonce`，SameSite=Strict，服务端按 sid 存储并校验；nonce 一次性、60s TTL）。`Origin` / `sec-fetch-site` / `x-forwarded-host` 都是请求方可伪造的头，**不再单独作为授权证据**；②**配了**——普通交互（`/act`、`/saves/open`、`/saves/back`）仍允许同源浏览器通过，破坏性 `/ctl` **只认** `authorization: Bearer <token>` 或 `x-ctl-token`。**唯一例外**：MAIN 的 `survival_reset` 允许“服务端会话 nonce”（一次性 + 60s TTL + 全局 3 次/分钟 + `[audit] main_reset` 审计事件），用于浏览器“新开一局”；全局 reset/具名营地不受此例外影响。公开部署建议设，令牌只进密文变量 |
| `CHAT_TOKEN` | `/chat` 转发默认**关闭**（返回 404）。不设就没人能用它烧你的模型额度（这是有意的默认） |
| `MAX_CALLS` | 每日模型调用额度。不设默认 120；公开实例建议按预算设小 |
| `PRESENCE_MS` | 无人观看时停调真模型的窗口。**单位是毫秒**：想 60 秒要写 `60000`，写 `60` 只有 60 毫秒 |

其它已内置的防护：静态面白名单 + realpath（**只放 `/web/` 与 `/shared/`**；`shared/` 只允许纯数据/几何，
不得放服务端逻辑或秘密）、`/healthz` 不回显密钥/端点/数据目录、普通请求体上限 64 KB（`/import` 使用独立上限）、畸形 URL 与未捕获异常不会杀进程、
`world.json` 原子写 + `.bak` 轮转、CSP `default-src 'self'` + `frame-ancestors 'self' https://*.ms.show
https://modelscope.cn https://www.modelscope.cn`（平台要嵌 iframe，所以**不设** `X-Frame-Options`）+ `X-Content-Type-Options: nosniff`
、存档错误只回错误码（不回显绝对路径）、HTTPS 部署时 cookie 带 `Secure`
（可用 `COOKIE_SECURE=1` 强制）。

**营地归属与访客投影（SEC5-02 / DATA5-05 / A′）**：创建营地时下发 `camp_owner`（HttpOnly cookie），索引只存其 sha256（`ownerHash`），并原子写入侧车 `saves/<key>.owner.json`（name + ownerHash）。非 MAIN 的完整 `/world` 视图要求匹配 owner 或有效 `CTL_TOKEN`；已登记营地的非 owner 只获独立白名单投影：camp key/名字、day、人口、settlement、最近 3 条事件 kind，不含背包、关系、对话、位置、建筑明细或 agent id。非法/未登记 key 仍拒绝。

写权限不随投影放开：已有 owner 的营地不能由同名非 owner 接管（`/saves/open` 返回 `CAMP_OWNED`，不换绑、不签新凭据），`/act` 仍检查归属。具名营地重置须先过 `/ctl` 守卫，再过 owner/令牌检查。索引整体丢失且无 corrupt 备份时，从 `saves/<key>.json.gz` + 侧车重建；无侧车旧档保留首次 claim 兼容。key 是归一化名字 sha256 的前 32 位十六进制，是**定位符而非凭据**。

**nonce 不是账号认证**：可完成 GET 的脚本也能获得会话；它防 CSRF，不证明操作者身份。MAIN 普通交互开放，MAIN `survival_reset` 即使配置 `CTL_TOKEN` 仍有上述 nonce 例外；限速默认 3 次/分钟（可配置），不是绝对禁止公众重开。不要将“配置令牌”描述成锁住所有写路由。

**名字营地备份**：`GET /export` 与 `POST /import` 由独立 `SAVE_EXPORT_TOKEN` 控制，未设返回 404，错误返回 401，并共用限流；当前实现从查询参数 `export_token` 取令牌。仅供受信管理员使用 HTTPS，避免 URL 被浏览器历史、代理/访问日志留存；服务端错误响应不回显令牌/路径不等于外部日志安全。导出含 gzip 档 base64、索引和 owner 侧车，应按私密数据保存；不含 MAIN 或 comparison。导入校验 32hex key、解压与档形状，已有 owner 的营地跳过，不覆盖/换绑；此接口直接写盘，不保证与运行中世界全局串行。全量恢复优先停服使用 `scripts/archive-saves.mjs` 的归档/哈希校验流程。

**持久化窗口**：启动会写一次基线档（主档可直接载入时不重写），`flushWrites`/SIGTERM 会收口；
硬杀进程仍可能丢 ≤`SAVE_EVERY` 刻（默认 10，可用 `SAVE_EVERY` 调小）。不做 WAL 就没有零丢失保证。

## 不在范围内

- 完整多租户与账号体系：营地使用 cookie 归属与访客投影，不是账号登录、身份恢复或分布式隔离系统。
- 当前线上 token 配置/轮换、浏览器验收与多人采样尚未找到当前证据，均待核实；本地 1309/1309 检查只证明对应代码闸门，不证明线上安全配置。
- 密钥管理：密钥只从环境变量读，不进前端、不进镜像、不进仓库。
