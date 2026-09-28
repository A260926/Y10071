# 契约变更审议台

把两份 OpenAPI 文档之间**真正影响调用方**的变化挑出来，逐条留下可追溯的接受 / 拒绝 / 带期限豁免决议。本地 TypeScript 服务 + 浏览器界面，数据存 SQLite（Node 内置 `node:sqlite`，无需原生编译）。

## 安装与演示

```bash
npm install
npm test -- --run
npm run dev -- --host 127.0.0.1 --port 5201
```

打开 <http://127.0.0.1:5201>，页面标题为「契约变更审议台」。

演示路径：创建审议单 → 内置示例选择 `breaking-change` → 点击「加载示例」→「生成差异 / 新建修订」→ 可看到 5 条差异（路径参数改名、required 变化、枚举收窄、响应状态消失、nullable 变化），任选一条填写操作者 / 理由 / 到期时间，状态选「带期限豁免」并提交。

## 差异类别

| 类别 | 含义 |
| --- | --- |
| `path-param-renamed` | 路径模板中的参数改名（其余路径段相同） |
| `required-changed` | 字段或参数的 required 增减 |
| `enum-narrowed` / `enum-widened` | 枚举取值收窄 / 放宽 |
| `response-removed` / `response-added` | 响应状态码消失 / 新增 |
| `nullable-changed` | 字段可空性变化（兼容 OpenAPI 3.0 `nullable` 与 3.1 `type: ["string","null"]`） |
| `type-changed`、`property-removed`、`property-added`、`operation-*`、`parameter-*` | 其他结构性变化 |

纯描述性内容（`description`、`summary`、`example` 等）不进入规范化结果，因此不会产生差异；JSON 与 YAML、属性书写顺序不同也不会产生差异。

## 差异身份如何计算

1. 解析两份文档并**规范化**：解析 `$ref`（遇到引用循环时打 `circularRef` 标记并停止该分支）、合并 `allOf`（properties 取并集、required 取并集、enum 取交集）、属性名与 required 排序、enum 值排序、`type` 数组中的 `null` 归一为 `nullable`，并丢弃 description 等非契约字段。
2. 在规范化结果上做结构比对，为每条差异计算身份：
   `identity = sha1(category + "|" + location + "|" + subject).slice(0,16)`。
   - `location` 是稳定的操作位置，如 `GET /users/{}`（路径参数名统一擦除为 `{}`，因此参数改名不会改变同操作内其他差异的身份）；
   - `subject` 是差异主体的稳定路径，如 `response:200:application/json/properties/role` 或 `required:email`；
   - `category` 是上表的类别。
3. 修订身份使用**两份文档规范化结果的哈希对**（`sha256(sha256(before) + "\n" + sha256(after))`）。重新上传内容相同但排版 / 属性顺序 / JSON↔YAML 不同的文档时，直接复用原修订与原差异，不新建任何数据。

## 决议继承与不继承

决议按 `(审议单, 差异身份)` 保存，不挂在某一次上传的原始文本上：

- 新修订中**仍然存在且身份相同**的差异，自动沿用已有决议（无需重审），新事件仍会记录决议所依据的最新文档摘要。
- 以下情况**不会继承**决议：差异在新文档中消失（问题被修掉或接口被删除）；差异的类别、稳定位置或主体路径变化（例如路径结构变化导致 `location` 改变、schema 被移动导致 `subject` 改变、收窄变成加宽导致 `category` 改变）。这些变化会以新身份出现，需要重新审议。
- 历史修订只读：只有当前最新修订中存在的差异允许提交决议；针对旧差异的写入返回 400。

## 豁免与并发

- 豁免必须带晚于当前时间的期限。状态在**读取时推导**：`status = exempt` 且 `now >= deadline` 时对外呈现为 `expired`，数据库中的事件历史保持不变（没有任何后台任务改数据）。时钟来自 `src/clock.ts`，可在测试中替换。
- 每条决议带 `version`。保存时必须携带 `expectedVersion`：不匹配返回 `409`，响应体含 `current`（服务器当前版本）与 `attempted`（本次提交内容），界面据此让用户重试。
- 每次决议在同一审议单内产生顺序递增的 `event_no`，并记录操作者、理由、到期时间以及 before/after 两份文档的规范化摘要（标题、版本、sha256）。
- 上传两份文档时先解析、校验、规范化、比对全部成功，才在一个事务里写入修订与差异；任一份失败返回 400 并带文档侧（before/after）、行列与附近原文，半份文档不会入库。

## 调用方影响说明

每张差异卡片提供「复制调用方影响说明」。文案完全由服务端根据**结构化差异**（类别 / 位置 / 主体 / detail 字段）生成，见 `src/impact.ts`。用户填写的理由只作为纯文本存储与展示，不参与模板拼接求值，不会被当作代码执行。

## Fixtures

`fixtures/` 内置至少四组（外加演示用 `breaking-change`）：

- `breaking-change`：覆盖五个核心类别的综合示例（演示用）；
- `circular-refs`：`$ref` 互相引用的循环结构；
- `allof-merge`：`allOf` 合并 required；
- `same-name-scopes`：两个作用域下同名属性，只改其中一个；
- `description-only`：JSON/YAML 混用且只有描述变化（零差异）。

## API 摘要

- `POST /api/tickets`：创建审议单；
- `POST /api/tickets/:id/revisions`：`{before, after}` 原始文本，返回新建或复用的修订；
- `GET /api/tickets/:id`：当前修订、差异（含决议与推导出的有效状态）、历史修订只读标记；
- `PUT /api/tickets/:id/diffs/:identity/decision`：提交决议（乐观版本号，冲突 409 带双方内容）；
- `GET /api/tickets/:id/events`：顺序递增的决议事件流；
- `GET /api/fixtures` / `GET /api/fixtures/:name`：内置示例列表与内容。

数据库默认在 `data/review.sqlite`，可用环境变量 `CONTRACT_DB` 覆盖（测试使用内存库）。
