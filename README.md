# 清晰 · 需求评审 Agent MVP

根据[《需求评审 Agent 调研》](https://chatgpt.com/share/6ad0a2fb-fd64-83e8-b7cf-97e033e72aff)实现的本地单用户应用。评审工作台仅接受飞书文档链接，直接使用已配置的 AI 模型。

## 启动

需要 Node.js 24 或更高版本（使用内置 SQLite）。

```bash
npm ci
npm start
```

打开 <http://127.0.0.1:3210>，完成模型配置和飞书授权后，输入飞书 docx/wiki 需求链接，点击“开始评审”。页面不再提供示例、粘贴文本或评审方式选择。

```bash
npm run dev    # 开发模式，后端代码变更自动重启；前端变更刷新浏览器
npm run check  # JavaScript 语法检查
npm test       # 核心规则、接口与连接适配器测试
```

测试使用临时数据库和模拟上游，不产生模型费用或真实飞书文档。HTTP 测试会监听本机临时端口；受限制的沙箱需要允许本机监听。

## 已实现

- 中文工作台、内置退款需求样例、粘贴文本、飞书 docx/wiki 链接输入。
- 八个维度，P0/P1/P2 分级；区分原文事实、推断建议、待澄清。
- 校验引用是否存在于原文；不可靠引用强制降级为待澄清，去除重复标题。
- 报告预览、原文高亮定位、优先级/类型筛选、搜索、人工采纳/不采纳。
- Markdown 和 JSON 导出，SQLite 评审记录、原文快照与 SHA-256 指纹。
- 后台任务、明确的错误状态、幂等请求、重启后中断恢复。
- OpenAI Responses / Chat Completions 兼容接口适配；飞书官方 Streamable HTTP MCP 读取、独立报告创建、回读核验。
- 发布结果未知时阻止自动重复创建；有 URL 的报告回读失败后，仅重试核验。

演示模式**不会调用模型、访问飞书或创建云端报告**。真实连接代码有模拟接口测试，但完整的模型 + 飞书端到端联调仍待真实凭据验收。

## 配置真实服务

```bash
test -f .env || cp .env.example .env
```

在本地编辑 `.env`，重启服务，然后进入“连接设置”。不要提交 `.env`。状态“已配置”仅表示配置存在，不表示真实调用已通过。

### 模型

选择服务商，填写该服务商的 Key 和模型 ID，其余可留空：

```dotenv
LLM_PROVIDER=gemini
LLM_API_KEY=在本地填写
LLM_MODEL=你的模型ID
LLM_API_MODE=
LLM_BASE_URL=
LLM_OUTPUT_FORMAT=
```

| LLM_PROVIDER | 默认 Base URL | 接口 | 输出方式 |
| --- | --- | --- | --- |
| openai | https://api.openai.com/v1 | responses | json_schema |
| gemini | https://generativelanguage.googleapis.com/v1beta/openai | chat | json_object |
| deepseek | https://api.deepseek.com | chat | json_object |
| agnes | https://apihub.agnes-ai.com/v1 | chat | text |
| custom | 必须自行填写 | chat | json_object |

设置页显示当前实际地址，并提供各服务商配置示例。示例选择器不会修改配置。`LLM_API_MODE`、`LLM_BASE_URL`、`LLM_OUTPUT_FORMAT` 非空时覆盖预设，因此切换服务商时请清除旧值。未配置 `LLM_PROVIDER` 的旧安装仍默认使用 OpenAI。服务商地址与预设域名不一致时阻止请求；使用代理或第三方兼容平台请选择 `custom`。地址只填根路径，不含 `/chat/completions` 或 `/responses`，不允许查询参数中的密钥。

- `json_schema`：服务端结构化输出；仍会在本地验证。
- `json_object`：上游保证 JSON，提示词提供完整 schema，本地验证字段与证据。
- `text`：不传 response_format，通过提示词请求 JSON；适用于未确认结构化输出支持的 Agnes 或自定义平台。模型返回围栏、解释或不合规结构会明确失败，不会当成有效报告。

Gemini 默认使用 JSON 模式：当前账户模型的完整 JSON Schema 请求实测返回 HTTP 400，JSON 模式已通过真实评审和本地校验；可在确认模型支持后显式选择 `json_schema`。服务商预设不代表所有模型均支持所选输出方式。模型 ID 使用账户控制台提供的准确名称；没有跨服务商自动重试。真实评审会将需求正文发送至已配置的服务商。开始评审前需要完成模型配置和飞书授权。

参考：[Gemini 兼容接口](https://ai.google.dev/gemini-api/docs/openai)、[DeepSeek JSON 模式](https://api-docs.deepseek.com/guides/json_mode/)、[Agnes 官方接口说明](https://agnes-ai.com/en/docs/overview)。

### 飞书

首次在本地 `.env` 配置应用凭据后，打开工作台，点击“使用飞书登录”，用自己的账号确认。三个 QA 模块共用本次登录和授权。

```dotenv
FEISHU_APP_ID=你的应用AppID
FEISHU_APP_SECRET=你的应用AppSecret
FEISHU_REDIRECT_URI=http://127.0.0.1:3210/api/auth/feishu/callback
```

在飞书开发者后台登记相同回调地址，开通 `offline_access` 及文档工具所需权限，并将自己的账号加入应用可用范围。完整权限表、配置和扫码验收步骤见 [飞书接入指南](docs/feishu-setup.md)。日常无需复制用户 Token；访问/刷新凭据在本机加密保存，使用时自动续期，失效时提示重新扫码。

本地工作台绑定一个飞书账号，登录会话有效期为 7 天。迁移已有业务记录及限制企业范围的方法见飞书接入指南。`FEISHU_ALLOWED_HOSTS` 可限定可读租户域名（逗号分隔）。

程序仅开放 `fetch-doc`、`create-doc`，启动连接时通过 `tools/list` 获取真实 schema 并在调用前校验。`fetch-doc` 传递完整 `doc_id` URL，由官方工具处理 wiki 节点解析；不将 wiki token 当作文档 ID。创建使用 `{title, markdown}`。若实际工具版本字段或返回结构有变化，程序明确报错，不猜测或伪造成功链接。

身份需要拥有源文档的读取权限及新文档创建权限，具体权限以开放平台的工具授权为准。扫码登录支持自动续期；手动 Token 仍需到期后自行更新。工具发现成功不等于拥有某份文档的访问权限。

在工作台输入飞书链接；可勾选评审后创建报告，也可先查看报告再点击“生成飞书报告”。新报告在当前用户默认空间创建，程序不修改原文、不调用分享或公开权限接口；最终可见性仍受租户策略影响，真实联调时需核实。

如写入请求超时且没有返回 URL，应用显示“结果未知”并停止自动重试。请先在飞书核实是否已经创建。已有 URL 的回读失败可点击“重新核验”。后续人工采纳状态保存在本地；已发布报告是发布时的快照，界面会提示其已过期，不会自动覆盖。

## 数据与边界

- 默认仅绑定 `127.0.0.1`，没有多人身份认证；不能直接作为公网或团队服务部署。Host、Origin 和跨站请求检查防止其他网站直接调用本地 API。
- 数据保存在 `data/reviews.sqlite`，包含原文、引用和报告，是本地敏感业务数据。目录权限默认 700、数据库 600；可通过 `DATA_DIR` 修改位置。评审数据没有定时清理、加密存储或备份系统。飞书登录凭据单独加密存储在 `data/auth/`，本地密钥与凭据文件均为 600 权限。
- 单份正文最多 48,000 字符，最多两个并发任务；超长文档明确拒绝，不静默截断。MVP 暂未实现长文分段与跨片段汇总。
- 飞书文档默认同时读取图片与画板进行视觉分析；可取消勾选以仅评审正文。未读取、无法辨认和部分可辨认的资源单独列出，附件/电子表格尚未展开。
- 原文定位是读取快照的章节/行号，未实现飞书原生 block 深链接。引用存在只证明出处，不证明模型推理正确。
- 去重按归一化问题标题进行，不是语义去重。模型置信度是未校准自评，不代表实测准确率。
- 不自动修改需求、发送通知或触发审批。自动重评审、版本差异、多人协作、自定义规则与评审质量评估集属于后续范围。

## 代码结构

```text
public/              无构建依赖的浏览器界面
src/server.js        HTTP API、任务编排、发布状态与访问保护
src/review.js        评审 schema、演示规则、证据校验与报告渲染
src/integrations.js  模型 API 与飞书 MCP 适配器
src/feishu-auth.js   飞书 OAuth、加密凭据保存与刷新
src/store.js         SQLite 持久化和中断恢复
tests/               单元与 HTTP 集成测试
docs/                MVP 范围与验收记录
```

## 接口

| 路由 | 用途 |
| --- | --- |
| `GET /api/config` | 不含密钥的配置状态 |
| `GET /api/sample` | 内置演示 PRD |
| `POST /api/tasks` | 创建任务，支持 `Idempotency-Key` |
| `GET /api/tasks` | 任务列表 |
| `GET /api/tasks/:id` | 详情、原文、进度和报告 |
| `PATCH /api/tasks/:id/issues` | 人工确认：`issueId`、`status` |
| `GET /api/tasks/:id/export?format=markdown` | Markdown 导出；也支持 `json` |
| `POST /api/tasks/:id/publish` | 创建报告或重试已有报告的核验 |
| `GET /api/auth/session` | 获取当前浏览器的登录状态 |
| `POST /api/auth/feishu/start` | 发起飞书 OAuth 登录 |
| `GET /api/auth/feishu/callback` | 接收授权回调（校验 Cookie/state/PKCE） |
| `POST /api/auth/feishu/logout` | 清除本机登录状态 |
| `POST /api/auth/feishu/cancel` | 取消未完成的登录 |
| `POST /api/connections/check` | 检测飞书 MCP 工具可用性 |

## 接口参考

- [飞书官方远程 MCP 工具清单](https://open.feishu.cn/document/mcp_open_tools/supported-tools?lang=zh-CN)
- [飞书官方 MCP Node.js 示例](https://github.com/larksuite/lark-samples/blob/main/mcp_quick_remote_demo/nodejs/README.md)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)


## 图片、原型图与画板评审

在工作台输入飞书文档链接，默认勾选“分析图片、原型图与画板流程图”。旧报告保留原来的纯文本结果，需要新建评审才能纳入图片。

- 通过用户身份下载飞书内嵌图片；原图下载 403 时按飞书 CLI 的 media-preview 规范请求预览版本。画板读取截图和必要的节点/连线结构。外部图片 URL 不自动访问。
- 每份最多处理 24 个去重资源。下载限制 16 MiB、解码限制 4,000 万像素；长图保留全图并最多切成 8 个细节分片。超过分片预算时明确提示只使用缩放概览；动态图仅首帧，SVG 不执行。
- 先识别每个资源的可见文案、控件、页面状态和流程，再将视觉观察与正文交给综合评审。图中指令视为不可信内容。
- 视觉引用具有 V001 等资源编号、原文位置、图内位置与本地图片快照。视觉观察仅说明已定位到模型识别记录，不能冒充逐字原文校验，结论需要人工复核。
- 下载/识别失败保留其他资源的结果；资源清单明确列出遗漏。所有失败不会被标为“已完整分析”。视觉观察最多 60,000 字符送入综合评审，超过预算的部分明确记录。
- 图片快照保存在 `data/visuals/<task-id>/`，仅通过本机同源 API 提供；不把 Base64 图片写入任务 JSON/导出，也不公开上传。图片仍会发送到你配置的模型服务用于识别。可删除相应任务目录清理快照。
- Markdown 和飞书报告包含资源覆盖清单、视觉观察与资源指纹；云端报告不重新上传原图，通过原文位置回到原始需求查看。

模型需支持图像输入。当前 Gemini 配置可使用；OpenAI 通过对应 Responses/Chat 图像格式接入，具体模型须支持视觉。DeepSeek 默认关闭视觉，Agnes/自定义服务需确认选用模型支持后设置 `LLM_VISION_ENABLED=true`。纯文本模型不会声称已经看过图片。

飞书应用还需开启并授权 `docs:document.media:download`、`board:whiteboard:node:read` 两项用户权限；已有正文授权保持可用，在连接设置中重新扫码可补充权限。

实现参考：[Gemini 图像输入](https://ai.google.dev/gemini-api/docs/openai#image-understanding)、[飞书下载素材](https://open.feishu.cn/document/server-docs/docs/drive-v1/media/download)、[画板截图](https://open.feishu.cn/document/docs/board-v1/whiteboard/download_as_image)、[画板节点](https://open.feishu.cn/document/docs/board-v1/whiteboard-node/list)。

## 测试用例与版本报告

工作台新增两个入口（真实模型模式）：

- **生成测试用例**：输入飞书 docx/wiki 需求链接，并选择“在知识库节点下新建”或“写入已有原生思维笔记”。可读取图片与画板，生成最多 80 条用例，包含模块、优先级、前置条件、步骤、逐步预期、原文引用及待确认事项。可先在本地预览，再发布为**原生飞书思维笔记**。知识库创建接口使用 `obj_type=mindnote`，随后调用 Mindnote 节点接口组织模块与用例；用例细节在节点备注里。新建需要父节点的子节点创建权限。若结果需放在云盘，可先在飞书新建空白原生思维笔记并放到所需位置，选择“写入已有原生思维笔记”后粘贴 `/mindnotes/` 或指向 Mindnote 的 `/wiki/` 链接。应用会追加独立任务分支、保留其他内容，并回读校验全部用例及备注；不接受用画板替代原生笔记。
- **版本测试报告**：输入飞书多维表格 base/wiki 数据表链接，读取数据表和字段，确认版本、缺陷标题、状态、严重程度字段（模块、描述可选），填写版本精确值和已关闭状态值。分页读取可见数据，程序计算统计，AI 提出引用具体记录 ID 的风险与建议，结果可发布为独立飞书云文档。

新增用户身份权限：`mindnote:node:read`、`mindnote:node:create`、`bitable:app:readonly`。在开发者后台添加、发布后，在连接设置重新扫码授权。原有评审不因这三项权限缺失而停用。手动设置 `FEISHU_OAUTH_SCOPES` 时需把新权限加入列表。

版本统计忽略 URL 中的视图筛选，按整个数据表里**当前身份可见记录**精确筛选版本；文本/单选版本字段整体匹配，多选版本字段逐项匹配。已解决不自动计为已关闭。无匹配记录、分页不完整、重复记录或超出上限时明确报错，不生成零缺陷结论。最多读取 10,000 条、100 页，模型输入最多 100,000 字符，云文档报告回读最多 48,000 字符；不会静默截断。

报告是当前缺陷快照，不是历史版本状态还原。只有 BugList 时无法推导测试通过率、覆盖率或是否可以上线。用例是待人工确认的设计草稿，未执行测试。

Mindnote 写入前持久化批次正文与幂等标识，回读核验层级、标题和备注；写入中断可继续已有笔记。新文档创建结果未知时禁止自动重复创建，避免重复文件。

## 成本、审核、追溯与执行（2026-10-16）

新增侧栏 **成本台账**、**测试执行**；各报告底部增加 **审核、追溯与执行**。

1. 在任务报告里逐项审核摘要、评审意见、用例或风险。填写审核人和理由，可采纳、修改后采纳、驳回或退回待审核。修订会保存原始生成稿、修订内容和操作历史；这些记录不会自动训练模型。
2. 在需求基线中对照原文补充、确认或排除需求点，再确认完整范围。初始候选只来自模型引用，不是完整需求清单。同文档同正文指纹的任务可复用尚未被人工修改的基线；图像变化仍需人工核查，复用后重新确认范围。
3. 将用例关联到已确认需求点，可按原句匹配，再人工检查。覆盖率只统计已采纳用例关联的已确认需求；未确认范围时不显示百分比。
4. 到测试执行页选用例任务，填写版本精确值、环境、构建号和负责人。只纳入已采纳用例；用例、审核和需求关联都冻结为计划快照。
5. 手动记录执行状态、实际结果、证据、执行人和缺陷记录 ID，或下载模板后导入 JSON/CSV。先预览再确认，任意一行无效则整批拒绝。重复用例、未知用例、非法状态、过期修订号均拒绝，已保存记录保留变更历史。
6. 在版本缺陷报告底部关联同版本执行计划，并确认属于同项目和范围。报告保留关联时的执行快照；后续执行结果更新后需要重新关联。Markdown 和飞书修订版包含程序计算的执行统计和缺陷 ID 匹配结果。
7. 原飞书报告保留发布时快照。修改后可导出最新版，或点击“发布独立修订版”创建独立云文档/思维笔记任务分支，不覆盖原报告。创建或回读未完成时先核验原快照，再修改内容。

**统计口径**：通过率 = passed / (passed + failed)；阻塞、跳过、未执行分别展示，不算入该分母。通过率没有数据时为未知。需求覆盖率是用例设计关联覆盖，不是执行通过率，也不代表业务正确或允许上线。执行数据来自人工/外部导入，当前版本不自动运行 UI/API 测试。

**模型成本**：所有 `requestModel` 调用在开始和结束时记录操作、模型、输入/输出/缓存/思考 token、耗时和费用估算。失败、截断及 JSON 解析失败仍记录已知用量；网络中断或缺失 usage 的费用未知，不记作免费。Chat/Responses 的输出总量已含 reasoning，不重复累加；原生 Gemini usageMetadata 分项相加。历史任务不补算。官方 Gemini 3.8 Flash 标准单价预设仅在已核实的 2026-10-16 至 2026-12-31 有效，之后显示单价未知；其他模型使用下方可选配置。估算不是账单，不含税费或额度折扣。

```dotenv
# 可选，每百万 token 的美元单价；切换服务商/模型时同时调整。留空使用有效预设。
LLM_INPUT_USD_PER_MILLION=
LLM_OUTPUT_USD_PER_MILLION=
LLM_CACHED_USD_PER_MILLION=
# false 可强制重新分析图片；默认 true
VISUAL_CACHE_ENABLED=true
```

图像分析缓存保存在私有 `data/visual-cache/`，有效期 30 天。每次仍重新授权并下载素材，对原始内容、正文指纹、画板节点、模型/接口、提示词、资源位置和处理规格生成缓存键；相同快照可跨评审/用例任务复用。资源变化或无法读取时不会用缓存冒充新结果。清理缓存目录可释放空间，不影响已生成报告。

接口：`PATCH /api/tasks/:id/quality`、`POST /api/tasks/:id/execution`、`POST /api/tasks/:id/republish`、`GET/POST /api/runs`、`GET /api/runs/:id`、`POST /api/runs/:id/results`、`POST /api/runs/:id/import`、`GET /api/runs/:id/export?format=json|markdown|template`。修改请求携带页面读取的 revision，冲突返回 409。CSV 表头为 `caseId,status,actual,tester`，可选 `evidence,bugIds`；状态为 `not_run,passed,failed,blocked,skipped`，缺陷 ID 多值使用逗号（CSV 内需引号包围）。

数据仍为本机单用户 SQLite；审核人是手动署名，不是多人身份认证。历史表保留，执行计划新增 `qa_entities` 表。升级前建议备份 `data/reviews.sqlite`。
