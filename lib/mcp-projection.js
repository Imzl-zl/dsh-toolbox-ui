// MCP 配置的**投影**规则：对外只给掩码，给眼睛的那条通路给有效运行值。
//
// 最初从 lib/index.js 搬出；当前统一适配 raw/YAML 值，读取不执行表达式。这一层只有一条纪律：
// 同一份配置在三个地方出现（列表行 / 详情行 / 导入预览）时，**哪些字段被遮、遮成什么、
// 编辑时怎么把保留标记还原回去**必须由同一处决定——曾经不同通路各写一份，于是同一个
// token 在一个视图里是掩码、在另一个视图里是原文。
//
// 两个方向在这里成对存在，不许只改一半：
//   · 读出去（redact*/restoreTemplate）——默认一律掩码，明文与 `!!js` 引用一视同仁；
//   · 写回授权住在 mcp-update-values.js：保留标记/字段引用只绑定锁内的当前条目与原字段。
//     新增/导入不能借用这条更新授权。
import { interpolate } from "@deepseek-ai/cordis-plugin-loader";
import { setOwn } from "./own-property.js";
import { evaluateEnvExpression, jsExpressionToTemplate } from "./workspace-config.js";
import { expressionText, fieldKind, literalValueValid, MCP_FIELD_SCHEMA, MCP_REDACTED_VALUE } from "./mcp-value-schema.js";

const REDACTED_VALUE = MCP_REDACTED_VALUE;

// env/headers 的值默认一律掩码：不显示任何实际内容，明文与 `!!js` 引用一视同仁。
// 旧实现把 `!!js process.env.X` 当作「安全引用」保留下来，结果同一份配置会因为写法不同
// 而一个掩盖码、一个把内部 `!!js` 表达式原文摆到界面上（用户看到的正是后者）。
// 需要看真实值时走 reveal（眼睛）——那条通路给的是「有效运行值」。
// key 名保留：用户需要知道配了哪些字段。
function redactMap(value) {
	const result = {};
	for (const key of Object.keys(value || {})) setOwn(result, key, REDACTED_VALUE);
	return result;
}
function redactUrl(value) {
	// `!!js` 表达式可能内嵌密钥，且内部语法不该出现在界面上：一律掩码（不管简单还是复杂）。
	if (typeof value === "string" && value.startsWith("!!js ")) return REDACTED_VALUE;
	try {
		const parsed = new URL(value);
		return parsed.username || parsed.password || parsed.search || parsed.hash ? REDACTED_VALUE : value;
	} catch {
		return REDACTED_VALUE;
	}
}
function redactArgs(value) {
	return value.length ? [REDACTED_VALUE] : [];
}
function containsRedactedValue(value) {
	if (value === REDACTED_VALUE) return true;
	if (Array.isArray(value)) return value.some(containsRedactedValue);
	if (value && typeof value === "object") return Object.values(value).some(containsRedactedValue);
	return false;
}

// ---------- workspace 项目层展示与校验 ----------
// 内部 spec 的 `!!js` 表达式 → 文件中的 `${VAR}` 模板形式；还原失败时原样返回（只影响展示，不落盘）。
function restoreTemplate(value) {
	if (typeof value !== "string" || !value.startsWith("!!js ")) return value;
	try { return jsExpressionToTemplate(value); } catch { return value; }
}
// One privacy dispatch serves row projection and its expression metadata; no source value is serialized as a command.
const valueRedactors = { list: redactArgs, map: redactMap, url: redactUrl };
const emptyProjectedValue = (kind) => kind === "text" ? "" : kind === "stringMap" ? {} : kind === "stringList" ? [] : undefined;

// Note: Read/edit/runtime values stay distinct — .agents/notes/implemented/2026-11-24-mcp-config-value-boundary.md
/** Raw loader/YAML values -> a safe read model. Expression state is not an evaluated primitive. */
function projectConfigValues(source, { scope = "global", managed = false } = {}) {
	const values = {};
	const configValues = {};
	for (const [field, schema] of Object.entries(MCP_FIELD_SCHEMA)) {
		if (schema.scope === "workspace" && scope !== "workspace") continue;
		if (!Object.hasOwn(source, field) || source[field] === undefined) continue;
		const value = source[field];
		const kind = fieldKind(field);
		const expression = expressionText(value);
		const compoundExpression = kind === "reconnect" && value && typeof value === "object"
			&& Object.values(value).some((item) => expressionText(item) !== undefined);
		const redactor = Object.hasOwn(valueRedactors, schema.redaction) ? valueRedactors[schema.redaction] : undefined;
		if (expression !== undefined || compoundExpression) {
			setOwn(configValues, field, {
				kind: "expression", preservable: managed && field !== "transport" && schema.scope !== "lifecycle",
				transports: schema.transports.map((transport) => transport === "streamable-http" ? "http" : transport),
				...(redactor ? { hidden: true } : expression === undefined ? {} : { text: scope === "workspace" ? restoreTemplate(expression) : expression }),
			});
			if (field !== "transport" && field !== "disabled") {
				const projected = kind === "text" ? redactor ? REDACTED_VALUE : scope === "workspace" ? restoreTemplate(expression) : expression
					: kind === "stringList" ? [REDACTED_VALUE] : emptyProjectedValue(kind);
				if (projected !== undefined) setOwn(values, field, projected);
			}
			continue;
		}
		if (!literalValueValid(field, value)) {
			setOwn(configValues, field, { kind: "invalid", preservable: false, code: "MCP_VALUE_UNSUPPORTED" });
			if (field !== "transport" && field !== "disabled") {
				const projected = redactor && kind === "text" ? REDACTED_VALUE : emptyProjectedValue(kind);
				if (projected !== undefined) setOwn(values, field, projected);
			}
			continue;
		}
		// These two fields already have separate runtime/ownership projections on the row.
		if (field === "transport" || field === "disabled") continue;
		const projected = redactor ? redactor(value) : scope === "workspace" ? restoreTemplate(value) : value;
		setOwn(values, field, projected && typeof projected === "object" ? structuredClone(projected) : projected);
	}
	if (Object.keys(configValues).length) values.configValues = configValues;
	return values;
}

// ---------- 读「有效运行值」（详情页的眼睛）----------
// loader 把 `!!js` 表达式以 raw 形式留在 `entry.options.config`（官方为了写回保留 `!!js`
// 形式），到 apply 之前才用 loader 自己的 interpolate 求值。所以要把「解析后的值」显示出来
// 必须求值一次，而且必须用 entry 自己的 ctx——表达式可以引用该行 inject 的服务（官方用例：
// `!!js ctx.phaseOne.value`）。直接把 raw 当解析结果返回，对象就会序列化成 "[object Object]"。
const resolveLiveConfigValue = (entry, value) => interpolate(entry.ctx, value);
// 项目 spec 的字段值（内部 `!!js` 表达式）→ 有效运行值；与 `toMcpClientConfig` 用同一个求值器。
function resolveSpecValue(value, env) {
	if (typeof value === "string") return evaluateEnvExpression(value, env);
	if (Array.isArray(value)) return value.map((item) => resolveSpecValue(item, env));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSpecValue(item, env)]));
	return value;
}

export {
  REDACTED_VALUE,
  containsRedactedValue,
  projectConfigValues,
  redactArgs,
  redactMap,
  redactUrl,
  resolveLiveConfigValue,
  resolveSpecValue,
  restoreTemplate,
};
