# 契约变更审议台

在两份 OpenAPI 3.x 文档（before / after，JSON 或 YAML 均可）之间，只把**真正影响调用方**的变化筛出来，
逐条形成可追溯决议（接受 / 拒绝 / 带期限豁免）。本地服务 + 浏览器界面，数据落 SQLite。

## 安装

```bash
npm install
```

## 演示

```bash
npm test -- --run
npm run dev -- --host 127.0.0.1 --port 5201
```

打开 http://127.0.0.1:5201 ，页面标题为「契约变更审议台」。
点击「加载 breaking-change 示例」→「生成规范化差异」，即可看到参数改名、required 变化、枚举收窄、
响应状态消失、nullable 变化等分类；任选一条，选择「带期限豁免」并填入到期时间后提交，即完成一条决议。

数据库默认写在 `data/review.db`（可用环境变量 `DB_PATH` 覆盖，测试使用内存库）。

## 差异分类

- `property-added` / `property-removed`：对象属性增删
- `required-added` / `required-removed`：必填集合变化（参数、请求体、对象属性）
- `enum-narrowed` / `enum-widened` / `enum-replaced`：枚举集合收窄 / 放宽 / 互不包含
- `nullable-added` / `nullable-removed`：可空性变化（含 OpenAPI 3.1 的 `type: ["null", ...]`）
- `type-changed`：基础类型变化
- `parameter-renamed`：同位置参数改名（见下方启发式）
- `parameter-required-changed` / `parameter-added` / `parameter-removed`
- `response-status-removed` / `response-status-added`：响应状态码消失 / 新增
- `endpoint-added` / `endpoint-removed`
- `description-changed`：**仅**描述变化（子树存在结构差异时描述差异会被抑制）
- `ref-target-changed`：引用落点变化

**属性顺序变化永远不算变化**：规范化时对象按键名排序，属性表按集合比较。

## 差异身份（diff identity）如何计算

每条差异的身份键 `key` 与值无关，只由「版本前缀 + 变化类别 + 作用域 + 主体」决定：

```
v1/<category>/<scope as JSON Pointer segments>[ /<subject>]
```

- `scope` 是规范化文档中的作用域路径，例如
  `paths/~1pets~1{petId}/get/responses/200/content/application/json/schema/properties/status`。
  段内 `~`、`/` 按 RFC 6901 转义（`~0`、`~1`）。
- `subject` 是被改的成员名（属性名、`enum`、`required`、`name`、状态码等）。
- 路径段按「路径模板归一化」匹配：`/pets/{petId}` 与 `/pets/{id}` 归一成同一个路径键
  （`{...}` 统一替换成 `{}`），因此**路径参数改名**不会被误报成删接口 + 加接口。
- 改名参数的作用域按位置稳定：`parameters/<in>/#<同位置序号>`，因此 `petId → id`
  在多个修订间身份不变；普通参数变化则用 `parameters/<in>/<name>`。
  改名检测是启发式：同一 `in` 下，双方各有一个按名称配不上、且规范化类型相同的参数时判为改名。
- 同名不同作用域天然隔离：`components.schemas.Ticket.properties.status` 与
  `...creator.properties.status`（User）是两个不同 key，互不串味。

文档内容哈希（SHA-256 over canonical JSON，键排序、统一缩进）决定「是否是同一份文档」：
**排版不同但内容相同 → 哈希相同**，JSON 与 YAML 互换也一样。

### 规范化做了什么

1. YAML/JSON 解析；
2. 解析局部 `$ref`（`#/...`，不支持外部文件引用，遇到即拒绝导入）；
3. 循环引用：用「沿解析链的活动指针集合」检测，回到当前链上时把该落点记为原子的 `cycleRef`，
   共享子结构可被记忆化复用，递归保证终止；
4. `allOf` 合并成单一对象 schema（类型并集、属性合并、required 并集），
   因此「allOf 拼出来」与「直接摊平写」的两份 schema 比较结果为零差异；
5. 对象键排序、属性集合化、required 排序；
6. 3.0 的 `nullable: true` 与 3.1 的 `type: [..., "null"]` 统一成 `nullable` 标志。

## 修订、决议继承与只读历史

- 首次上传：创建审议单 + 修订 R1 + 差异集 + `revision-created` 事件。
- **重新上传内容相同（哈希相同）的一对文档**：直接复用原修订与原差异，`reused=true`，
  不产生新修订，**已有决议原样保留**（哪怕只是排版/键顺序变化）。
- **内容真变化**：生成 R2，R1 立即置为只读；差异按上面的身份键对齐。
  身份相同的差异**继承**最新决议（复制决议行并写 `decision-inherited` 事件，事件号全局递增），
  新出现的差异没有决议。

### 哪些变化不会继承决议

身份键 `v1/category/scope/subject` 必须**逐字节相同**才继承。以下任一变化都会使身份失配，
旧决议**不会**带到新差异上（必须重新审议）：

- 变化类别变了（如原来是 `enum-narrowed`，现在变成 `type-changed`）；
- 作用域变了：属性/参数所在的路径、嵌套层级、所属对象移动；
- 主体改名后未命中改名启发式（被识别为「删除 + 新增」而非 `parameter-renamed`）；
- 旧差异在新文档里消失（被删除的接口/属性没有继承者）；
- 接口本身被判定为 `endpoint-removed` / `endpoint-added`（路径模板归一化后仍配不上）。

继承只在「旧活动修订 → 新修订」之间做一次；旧修订保持只读，其事件永不改写。

## 决议、事件与豁免

- 决议记录：操作者、理由、状态、豁免到期时间、所依据的 before/after 两份文档摘要
  （title、version、路径数、内容哈希，快照进事件与决议行）。
- 事件表只追加：`revision-created`、`decision-made`、`decision-inherited`，
  `event_no` 在审议单内顺序递增。
- **豁免状态在读取时刻推导**：不存在后台定时器，也不回写历史。
  存储的 `state` 永远是 `exempted`；读取时若 `now > expires_at`，响应里
  `expired=true`、`effectiveState='rejected'`。服务时钟可替换（`new ReviewService(db, clock)`，测试用假时钟）。
- 输入校验：理由/操作者必填；豁免必须带可解析的期限。

## 并发写入（乐观锁）

每条差异带版本号（该差异的决议行数）。提交决议必须带 `baseVersion`：

- 一致：写入，版本 +1；
- 不一致：返回 `409`，响应同时包含**你的提交内容**与**对方已保存内容**
  （操作者、状态、理由、到期时间），界面展示双方差异并可用新版本号重试。

后保存永远不会静默覆盖先保存。

## 导入失败定位与原子性

- YAML/JSON 解析错误返回**所在文档（before/after）、近似 JSON Pointer 路径、行列号**；
  路径定位按缩进栈近似还原（如 `/paths/~1ok/get/responses`）。
- 结构校验（缺 `openapi`/`info`/`responses`、非法路径、无法解析的 `$ref` 等）同样带文档路径。
- 导入在单个数据库事务中完成：任一份文档失败，**审议单、修订、差异一行都不会落库**（半份文档不入库）。

## 调用方影响说明

每条差异在服务端由**结构化字段**（category/scope/subject/前后值）渲染一段中文「调用方影响说明」，
界面一键复制。用户理由只作为纯文本记录与展示（`textContent`），
不会拼进模板、不会渲染成 HTML、也不会被当作代码执行。

## Fixture（`fixtures/`）

- `breaking-change/`：演示用，覆盖参数改名、required、枚举收窄、响应状态消失、nullable、属性新增；
- `circular-ref/`：自引用 `Node`（parent/children），验证循环下规范化可终止并仍能识别差异；
- `allof-merge/`：after 是 before 中 allOf 结构的扁平等价写法，差异应为零；
- `name-shadowing/`：Ticket.status 与内嵌 User.status 同名不同作用域；
- `description-only/`：仅描述/排版变化，只产生 `description-changed`。

## 自动化测试

`npm test -- --run`（Vitest，内存 SQLite，可替换假时钟）直接验证：

- 规范化：属性顺序无关、allOf 等价、循环引用、同名作用域隔离、JSON/YAML 同哈希；
- 修订继承：排版复用不冲决议、真变化生成只读旧修订、身份相同才继承、身份变化不继承；
- 豁免边界：到期前 `exempted`、到期后读取推导为 `rejected`、历史行不变、豁免必须带期限；
- 并发写入：同版本号竞争产生 409，冲突体携带双方内容，可基于新版本重试；
- 导入失败：YAML/JSON 行列定位、半份文档不入库、坏 `$ref` 拒绝。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/cases` | body: `{title, before, after}`；创建审议单与首个修订 |
| `GET` | `/api/cases` | 审议单列表 |
| `GET` | `/api/cases/:id` | 当前活动修订视图（含差异、决议推导状态、版本） |
| `POST` | `/api/cases/:id/revisions` | 上传新一对文档；相同内容复用，真变化生成新修订 |
| `GET` | `/api/revisions/:id` | 任意修订（含只读历史修订） |
| `GET` | `/api/cases/:id/events` | 顺序递增事件流 |
| `PUT` | `/api/diffs/:diffId/decision` | `{caseId, baseVersion, state, actor, rationale, expiresAt?}`；冲突返回 409 |
