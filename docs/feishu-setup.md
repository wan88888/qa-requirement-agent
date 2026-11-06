# 飞书扫码登录与验收

现在支持使用自己的飞书扫码授权，应用自动保存和按需刷新凭据，无需复制 `FEISHU_USER_ACCESS_TOKEN`。

## 首次配置（只做一次）

1. 登录[飞书开发者后台](https://open.feishu.cn/app)，创建或选择企业自建应用，在“凭证与基础信息”取得 App ID 和 App Secret。开放平台创建的应用属于 Confidential Client，必须配置这两项；应用凭据不是用户 Token。
2. 在本地项目 `.env` 中填写：

   ```dotenv
   FEISHU_APP_ID=你的应用AppID
   FEISHU_APP_SECRET=你的应用AppSecret
   FEISHU_REDIRECT_URI=http://127.0.0.1:3210/api/auth/feishu/callback
   ```

   App Secret 只保存在本机服务端，不要发送到聊天或提交 Git。已有模型配置保持不变。
3. 在应用“安全设置 → 重定向 URL”中添加上面的完整回调地址。工作台应使用 `http://127.0.0.1:3210` 访问。`localhost` 和 `127.0.0.1` 不可混用；若修改 PORT，需要同时修改 `.env` 和开发者后台中的回调端口。
4. 在“权限管理”开通下表的**用户身份**权限。这是官方 Remote MCP 的 `fetch-doc` / `create-doc` 依赖范围，应用仍只开放这两个工具，不提供任务/群操作入口。

   | 权限 | 用途 |
   | --- | --- |
   | `offline_access` | 取得刷新凭据，自动续期 |
   | `docx:document:readonly` | 读取需求与回读报告 |
   | `docx:document:create` | 创建评审报告 |
   | `docx:document:write_only` | 写入新文档正文 |
   | `wiki:node:read`、`wiki:node:create` | 官方文档创建工具的知识空间依赖 |
   | `docs:document.media:download`、`board:whiteboard:node:read` | 图片/原型图与画板读取（新增用户权限，已有用户需补充授权） |
   | `docs:document.media:upload`、`board:whiteboard:node:create` | 官方文档创建工具的附件/画板依赖 |
   | `task:task:read`、`im:chat:read` | 官方文档读取工具的内容依赖 |

   权限依据[开发者调用远程 MCP 服务](https://open.feishu.cn/document/mcp_open_tools/developers-call-remote-mcp-server)。请以官方最新要求为准。设置页可展开查看实际请求列表；高级配置 `FEISHU_OAUTH_SCOPES` 可覆盖列表（空格或逗号分隔），但删减必要权限可能导致工具调用失败。
5. 将自己的飞书账号加入应用可用范围，按租户要求发布应用或配置测试版本。如果“安全设置”里有“刷新 user_access_token”开关，开启并发布生效；看不到该开关时，官方说明默认开启。管理员审批要求以控制台提示为准。
6. 停止旧服务，执行 `npm start`，刷新工作台。

## 日常登录

1. 打开本地工作台，点击“使用飞书登录”。如果从某份报告或某个模块进入，工作台会记住该页面。
2. **电脑浏览器**进入飞书官方授权页面；使用手机飞书扫描官方登录二维码，并确认应用权限。如果浏览器已经登录飞书，可能直接显示授权确认页。
3. 确认后，电脑浏览器返回原页面，侧栏显示当前飞书用户。需求评审、测试用例和版本测试报告共用此次授权。请使用发起登录的同一个浏览器，不要将完整授权链接当二维码发给手机打开：手机无法回调电脑的 127.0.0.1。
4. 在“连接设置”点击“检测飞书连接”，再用有权访问的测试 docx/wiki 链接进行真实评审。确认结果后点击“生成飞书报告”，检查新链接及回读结果。

授权请求 5 分钟内有效。拒绝授权、超时、浏览器不匹配或服务重启时，重新发起即可；如果从授权页返回但尚未完成，点击“取消本次登录”。授权期间暂不接受新评审/发布，避免过程中切换文档操作身份。

## 自动续期与退出

- 每次飞书请求前检查凭据，到期前按需刷新；并发请求共用一次刷新，新 refresh_token 原子替换旧值。
- 自动续期需要 `offline_access`、有效刷新凭据及服务端刷新开关。授权被撤销、刷新凭据过期或企业策略变化时需要重新扫码，不代表永久登录。
- Token 加密存储在 `data/auth/feishu-session.enc`，密钥在同目录的 `session.key`；文件权限 600，目录 700。它们不进入报告导出、浏览器存储或 Git。加密防止单独泄露凭据文件，不防御同一操作系统账户被攻陷；不要对外分享整个 data 目录。自定义 DATA_DIR 同样需要保护。
- “退出飞书登录”清除本机会话，不删除评审记录，也不撤销飞书服务器上的授权。撤销应用授权需要在飞书中操作。
- 本地浏览器会话最长 7 天，同一浏览器刷新或重启服务后仍可使用。重新登录会替换上一枚工作台会话，退出后必须重新登录才能访问业务接口。
- 当前为单用户工作台。首次登录空库时，工作台绑定已核验的应用、企业和用户身份。已有业务记录的旧库须先在本机设置 `FEISHU_WORKSPACE_OWNER_OPEN_ID` 为原账号在当前应用下的 Open ID，重启后用原账号登录。可通过 `FEISHU_ALLOWED_TENANT_KEYS` 限定允许的企业（多个值用逗号分隔）。
- 手动文档 Token 只能用于底层连接，浏览器工作台需要通过飞书登录建立会话。

## 实现与验收边界

采用官方 v1 授权页配合 v2 Token 接口（授权页文档注明的 PKCE 兼容组合）、随机 state、同浏览器 HttpOnly Cookie 和 PKCE S256。OAuth GET 回调及返回首页的顶层导航允许跨站进入，其他本地 API 保持原访问保护。授权码只使用一次，不记录回调参数或上游原始错误，完成后跳转到不含授权码的页面。

自动测试覆盖授权成功/拒绝、state 和 Cookie 校验、过期/重放、凭据保密、并发刷新、刷新撤销、登录退出竞态、重启恢复及 HTTP/MCP 连接。真实扫码必须配置应用并由用户自己在飞书确认；没有应用凭据时不能宣称真实联调通过。

官方参考：[获取授权码](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code)、[OAuth v2 换取凭据](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token)、[刷新凭据](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token)。

## 原生思维笔记与 BugList

添加并发布下列**用户身份**权限，再在本地连接设置重新授权：

| 权限 | 用途 |
| --- | --- |
| `mindnote:node:read` | 读取和核验思维笔记节点 |
| `mindnote:node:create` | 创建模块、用例节点及备注 |
| `bitable:app:readonly` | 列出多维表格的数据表、字段和记录 |

已有 `wiki:node:read` 与 `wiki:node:create` 用于定位知识库父节点并创建原生 Mindnote。父节点必须允许当前用户创建子节点。MCP 的 `create-doc` 只用于云文档报告，不用于 Mindnote；Mindnote 创建走 [创建知识空间节点](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/create)，文档类型选择 `mindnote`。节点读写路径为 `/open-apis/mindnote/v1/mindnotes/:mindnote_id/nodes`，使用同一 OAuth 用户身份。

BugList 使用 [列出字段](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-field/list) 和 [查询记录](https://open.feishu.cn/document/docs/bitable-v1/app-table-record/search)。如果启用高级权限，必须确保当前用户有足够的数据管理/可见权限；接口返回空记录不代表没有缺陷。仪表盘链接无法直接代表一张 BugList，请使用底层数据表链接。

云盘位置：当前公开的云空间创建接口未提供直接新建 Mindnote 的方式。可在飞书网页新建原生思维笔记，再移动到期望的云盘位置；应用选择“写入已有原生思维笔记”，使用已有 `mindnote:node:read` 和 `mindnote:node:create` 授权写入及回读，不依赖知识库父节点创建权限。已有 Wiki 链接必须解析为 `mindnote`，普通 docx/画板会被拒绝。空白笔记返回空节点列表时，应用创建任务根；每次写入持久化幂等键，重试不重复追加已核验内容。
