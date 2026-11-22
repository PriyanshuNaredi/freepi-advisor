#!/usr/bin/env node
/**
 * Headless checks for advisor.ts. No pi session, no real API calls.
 *
 *   node tests/run.mjs
 *
 * It needs the free-pi (or pi) package for the `typebox` and
 * `@earendil-works/pi-coding-agent` imports, and loads the extension through
 * pi's own jiti setup so the aliases match production. Set PI_PKG_DIR to point
 * at .../free-pi-cli/node_modules if auto-discovery fails.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname);
const extensionPath = join(here, "..", "advisor.ts");

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
	if (condition) {
		passed++;
		console.log(`  ok   ${name}`);
	} else {
		failures.push(name);
		console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

/** Find a node_modules dir that can satisfy `typebox`. */
function locatePiModules() {
	const explicit = process.env.PI_PKG_DIR;
	if (explicit && existsSync(join(explicit, "typebox"))) return explicit;

	const candidates = [];
	const npxRoot = join(homedir(), ".npm", "_npx");
	if (existsSync(npxRoot)) {
		for (const entry of readdirSync(npxRoot)) candidates.push(join(npxRoot, entry, "node_modules", "free-pi-cli", "node_modules"));
	}
	candidates.push(join(homedir(), ".npm-global", "lib", "node_modules", "free-pi-cli", "node_modules"));
	candidates.push(join(homedir(), "node_modules"));
	return candidates.find((candidate) => existsSync(join(candidate, "typebox"))) ?? candidates[0];
}

const modulesDir = locatePiModules();
const piPackage = join(modulesDir, "@earendil-works", "pi-coding-agent");
if (!existsSync(join(modulesDir, "typebox")) || !existsSync(piPackage)) {
	console.error(`Could not find the free-pi/pi packages for testing.\nTried: ${modulesDir}\nSet PI_PKG_DIR to the folder that contains "typebox".`);
	process.exit(2);
}

const workDir = mkdtempSync(join(tmpdir(), "advisor-test-"));
const agentDir = join(workDir, "agent");
mkdirSync(agentDir, { recursive: true });

// Mirror the extension into a folder whose node_modules resolves its imports.
const sandbox = join(workDir, "ext");
mkdirSync(join(sandbox, "node_modules", "@earendil-works"), { recursive: true });
writeFileSync(join(sandbox, "advisor.ts"), readFileSync(extensionPath));
const link = process.platform === "win32" ? "junction" : "dir";
symlinkSync(join(modulesDir, "typebox"), join(sandbox, "node_modules", "typebox"), link);
symlinkSync(piPackage, join(sandbox, "node_modules", "@earendil-works", "pi-coding-agent"), link);
if (existsSync(join(modulesDir, "@earendil-works", "pi-ai"))) {
	symlinkSync(join(modulesDir, "@earendil-works", "pi-ai"), join(sandbox, "node_modules", "@earendil-works", "pi-ai"), link);
}

process.env.PI_CODING_AGENT_DIR = agentDir;
for (const key of ["ADVISOR_MODEL", "ADVISOR_FALLBACKS", "ADVISOR_API_KEY", "ADVISOR_API_KEY_PROVIDER", "ADVISOR_BASE_URL", "ADVISOR_ENDPOINT_MODEL", "ADVISOR_ENDPOINT_API", "ADVISOR_ENDPOINT_PROVIDER", "ADVISOR_ENDPOINT_DEFAULT"]) {
	delete process.env[key];
}

const jitiUrl = join(piPackage, "node_modules", "jiti", "lib", "jiti.mjs");
const { createJiti } = await import(jitiUrl);
const register = (await createJiti(import.meta.url).import(join(sandbox, "advisor.ts"))).default;

/** Fresh extension instance, collecting UI and messages. */
function load() {
	const state = { commands: {}, tools: {}, handlers: {}, notices: [], messages: [], status: {} };
	const pi = {
		registerCommand: (name, options) => (state.commands[name] = options),
		registerTool: (definition) => (state.tools[definition.name] = definition),
		sendMessage: (message) => state.messages.push(message),
		on: (event, handler) => {
			state.handlers[event] = handler;
			return () => {};
		},
	};
	register(pi);
	return state;
}

const FREE_ASTRA = { provider: "free-pi", id: "gpt-6.2-astra" };
const FREE_SOL = { provider: "free-pi", id: "gpt-6.1-sol" };
const BYO_ASTRA = { provider: "openai", id: "gpt-6.2-astra", api: "openai-responses" };
const DEEPSEEK = { provider: "free-pi", id: "deepseek-v4.1-flash" };

function makeContext(models, { entries, advice = "advice", fail } = {}) {
	const calls = [];
	const transcript = entries ?? [{ type: "message", message: { role: "user", content: "add retries to the uploader" } }];
	const context = {
		cwd: join(workDir, "project"),
		sessionManager: { buildContextEntries: () => transcript, getBranch: () => transcript },
		modelRegistry: {
			getAll: () => models,
			getAvailable: () => models,
			hasConfiguredAuth: () => true,
			find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
			streamSimple: (model, ctx, options) => {
				calls.push({ model, ctx, options });
				if (fail) return { result: async () => ({ content: [], stopReason: "error", errorMessage: fail }) };
				return { result: async () => ({ content: [{ type: "text", text: advice }], stopReason: "stop" }) };
			},
		},
		ui: {
			notify: (message, kind) => context.__notices.push(`${kind ?? "info"}: ${message}`),
			setStatus: (key, value) => (context.__status[key] = value),
		},
		waitForIdle: async () => {},
		__calls: calls,
		__notices: [],
		__status: {},
	};
	return context;
}

async function run(state, context, args) {
	context.__notices.length = 0;
	context.__calls.length = 0;
	state.messages.length = 0;
	await state.commands.advisor.handler(args, context);
	return {
		used: context.__calls.at(-1) ? `${context.__calls.at(-1).model.provider}/${context.__calls.at(-1).model.id}` : undefined,
		prompt: context.__calls.at(-1)?.ctx.messages[0].content ?? "",
		notices: [...context.__notices],
		messages: [...state.messages],
		status: context.__status.advisor,
	};
}

// ---------------------------------------------------------------- mock endpoint
const seen = [];
const server = createServer(async (request, response) => {
	let body = "";
	for await (const chunk of request) body += chunk;
	let parsed = null;
	try {
		parsed = body ? JSON.parse(body) : null;
	} catch {
		parsed = null;
	}
	seen.push({ url: request.url, auth: request.headers.authorization ?? request.headers["x-api-key"], body: parsed });
	if (request.url.endsWith("/models")) {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: [{ id: "arena-large" }, { id: "arena-small" }] }));
		return;
	}
	if (request.url.endsWith("/chat/completions") || request.url.endsWith("/messages")) {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify(
				request.url.endsWith("/messages")
					? { content: [{ type: "text", text: "endpoint anthropic advice" }] }
					: { choices: [{ message: { content: "endpoint openai advice" } }] },
			),
		);
		return;
	}
	response.writeHead(404);
	response.end("not found");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const endpointBase = `http://127.0.0.1:${port}/api/v1`;

try {
	section("registration");
	{
		const state = load();
		check("registers /advisor", Boolean(state.commands.advisor));
		check("registers ask_advisor tool", Boolean(state.tools.ask_advisor));
		check("listens for session_start", Boolean(state.handlers.session_start));
		check("tool has a question parameter", Boolean(state.tools.ask_advisor.parameters?.properties?.question));
	}

	section("default resolution");
	{
		const state = load();
		const context = makeContext([FREE_ASTRA, FREE_SOL, DEEPSEEK]);
		state.handlers.session_start({}, context);
		check("footer names the free astra model", context.__status.advisor === "advisor: 6.2 astra", context.__status.advisor);
		const result = await run(state, context, "");
		check("review uses free-pi/gpt-6.2-astra", result.used === "free-pi/gpt-6.2-astra", result.used);
		check("prompt carries the transcript", result.prompt.includes("add retries to the uploader"));
		check("advice is posted with triggerTurn", result.messages[0]?.content?.includes("**Advisor · free-pi/gpt-6.2-astra**"));
	}
	{
		const state = load();
		const context = makeContext([FREE_SOL, DEEPSEEK]);
		const result = await run(state, context, "");
		check("falls back to gpt-6.1-sol", result.used === "free-pi/gpt-6.1-sol", result.used);
	}

	section("choosing a model");
	{
		const state = load();
		const context = makeContext([FREE_ASTRA, FREE_SOL, DEEPSEEK]);
		const oneOff = await run(state, context, "@gpt-6.1-sol is the retry safe?");
		check("@model asks that model", oneOff.used === "free-pi/gpt-6.1-sol", oneOff.used);
		check("@model keeps the question", oneOff.prompt.includes("is the retry safe?"));
		const flagged = await run(state, context, "-m gpt-6-luna check locks");
		check("-m resolves a loose id", flagged.notices.some((n) => n.includes("No single model matches")), flagged.notices.join("|"));
		const pinned = await run(state, context, "use gpt-6.1-sol");
		check("use pins the model", pinned.notices.some((n) => n.includes("pinned to free-pi/gpt-6.1-sol")));
		check("footer marks the pin", pinned.status === "advisor: 6.1 sol · pinned", pinned.status);
		check("pinned model answers the next call", (await run(state, context, "")).used === "free-pi/gpt-6.1-sol");
		check("set is an alias", (await run(state, context, "set default")).notices.some((n) => n.includes("default")));
	}

	section("empty session");
	{
		const state = load();
		const context = makeContext([FREE_ASTRA, FREE_SOL], { entries: [] });
		const hint = await run(state, context, "");
		check("no transcript, no question: explains", hint.notices.some((n) => n.includes("Nothing to review yet")), hint.notices.join("|"));
		check("no request is made", hint.used === undefined);
		const question = await run(state, context, "sqlite or postgres for a CLI?");
		check("question alone reaches the model", question.prompt.includes("sqlite or postgres for a CLI?"));
		check("question-only prompt says there is no transcript", question.prompt.includes("no session transcript yet"));
		const pin = await run(state, context, "@gpt-6.1-sol");
		check("@model with nothing to review pins instead", pin.notices.some((n) => n.includes("Pinned")), pin.notices.join("|"));
	}

	section("errors");
	{
		const state = load();
		const context = makeContext([FREE_ASTRA], { fail: "503 upstream" });
		const failed = await run(state, context, "");
		check("upstream failure is reported", failed.notices.some((n) => n.includes("503 upstream")), failed.notices.join("|"));
		check("no message is posted on failure", failed.messages.length === 0);
		const missing = await run(state, context, "@nope-nothing");
		check("unknown model is reported", missing.notices.some((n) => n.includes("No single model matches")), missing.notices.join("|"));
	}

	section("own API key");
	{
		const state = load();
		const context = makeContext([FREE_ASTRA, FREE_SOL, BYO_ASTRA]);
		process.env.ADVISOR_API_KEY = "sk-test-0123456789";
		const status = await run(state, context, "key");
		check("/advisor key reports the key without printing it", status.notices.some((n) => n.includes("ADVISOR_API_KEY") && !n.includes("sk-test")), status.notices.join("|"));
		const call = await run(state, context, "-m openai/gpt-6.2-astra is this safe?");
		check("explicit provider uses that provider", call.used === "openai/gpt-6.2-astra", call.used);
		check("own key is passed to the request", context.__calls.at(-1)?.options?.apiKey === "sk-test-0123456789");
		check("label marks the own key", call.messages[0]?.content?.includes("your key"));
		delete process.env.ADVISOR_API_KEY;
	}

	section("third-party endpoint");
	{
		const state = load();
		const context = makeContext([FREE_ASTRA, FREE_SOL]);
		process.env.ADVISOR_BASE_URL = endpointBase;
		process.env.ADVISOR_API_KEY = "endpoint-secret";
		process.env.ADVISOR_ENDPOINT_MODEL = "arena-large";
		process.env.ADVISOR_ENDPOINT_PROVIDER = "arena";

		const info = await run(state, context, "endpoint");
		check("/advisor endpoint shows base URL", info.notices.some((n) => n.includes(endpointBase)), info.notices.join("|"));
		check("/advisor endpoint hides the key", !info.notices.some((n) => n.includes("endpoint-secret")));

		const models = await run(state, context, "models");
		check("/advisor models lists endpoint ids", models.notices.some((n) => n.includes("arena-large") && n.includes("arena-small")), models.notices.join("|"));

		seen.length = 0;
		const call = await run(state, context, "@arena/arena-small why?");
		const request = seen.at(-1);
		check("explicit endpoint call posts to /chat/completions", request?.url === "/api/v1/chat/completions", request?.url);
		check("endpoint call sends the bearer token", request?.auth === "Bearer endpoint-secret", request?.auth);
		check("endpoint call sends the chosen model", request?.body?.model === "arena-small", JSON.stringify(request?.body?.model));
		check("endpoint advice is delivered", call.messages[0]?.content?.includes("endpoint openai advice"));

		const defaultCall = await run(state, context, "");
		check("endpoint is not default unless configured", defaultCall.used === "free-pi/gpt-6.2-astra", defaultCall.used);

		process.env.ADVISOR_ENDPOINT_DEFAULT = "1";
		seen.length = 0;
		const byDefault = await run(state, context, "");
		check("endpoint becomes default when asked", seen.at(-1)?.body?.model === "arena-large", `${seen.at(-1)?.body?.model} | ${byDefault.status}`);
		delete process.env.ADVISOR_ENDPOINT_DEFAULT;

		process.env.ADVISOR_ENDPOINT_API = "anthropic-messages";
		process.env.ADVISOR_BASE_URL = `http://127.0.0.1:${port}/api`;
		seen.length = 0;
		const anthropicCall = await run(state, context, "@arena/arena-large check");
		const anthropicRequest = seen.at(-1);
		check("anthropic style posts to /messages", anthropicRequest?.url === "/api/messages", anthropicRequest?.url);
		check("anthropic style sends x-api-key", anthropicRequest?.auth === "endpoint-secret", anthropicRequest?.auth);
		check("anthropic style reply is parsed", anthropicCall.messages[0]?.content?.includes("endpoint anthropic advice"));

		const pinnedFree = await run(state, context, "use free-pi/gpt-6.2-astra");
		check("an explicit provider is not hijacked by the endpoint", pinnedFree.notices.some((n) => n.includes("free-pi/gpt-6.2-astra")), pinnedFree.notices.join("|"));

		delete process.env.ADVISOR_BASE_URL;
		delete process.env.ADVISOR_API_KEY;
		delete process.env.ADVISOR_ENDPOINT_MODEL;
		delete process.env.ADVISOR_ENDPOINT_PROVIDER;
		delete process.env.ADVISOR_ENDPOINT_API;
	}

	section("endpoint config file");
	{
		const state = load();
		const context = makeContext([FREE_ASTRA]);
		writeFileSync(
			join(agentDir, "advisor-endpoint.json"),
			JSON.stringify({ provider: "filehost", baseUrl: `${endpointBase}`, apiKey: "file-secret", model: "arena-large", api: "openai-completions" }),
		);
		seen.length = 0;
		const call = await run(state, context, "@filehost/arena-small from file");
		check("file config is used", seen.at(-1)?.auth === "Bearer file-secret", seen.at(-1)?.auth);
		check("file config advice arrives", call.messages[0]?.content?.includes("endpoint openai advice"));
		rmSync(join(agentDir, "advisor-endpoint.json"));
	}
	{
		const state = load();
		const context = makeContext([FREE_ASTRA]);
		writeFileSync(join(agentDir, "advisor-endpoint.json"), JSON.stringify({ baseUrl: endpointBase, apiKey: "" }));
		const info = await run(state, context, "endpoint");
		check("empty apiKey keeps the endpoint inert", info.notices.some((n) => n.includes("No third-party endpoint")), info.notices.join("|"));
		rmSync(join(agentDir, "advisor-endpoint.json"));
	}

	section("transcript handling");
	{
		const state = load();
		const big = Array.from({ length: 400 }, (_, index) => ({ type: "message", message: { role: "user", content: `${"x".repeat(4000)}#${index}` } }));
		const context = makeContext([FREE_ASTRA], { entries: big });
		const result = await run(state, context, "");
		check("huge transcripts are capped", result.prompt.length < 200000, String(result.prompt.length));
		check("newest messages survive the cap", result.prompt.includes("#399"));
	}
	{
		const state = load();
		const messy = [
			{ type: "model_change", provider: "free-pi" },
			{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "edit", arguments: { path: "a.ts" } }] } },
			null,
			{ type: "message" },
		];
		const context = makeContext([FREE_ASTRA], { entries: messy });
		const result = await run(state, context, "thoughts?");
		check("odd entries do not break the review", result.used === "free-pi/gpt-6.2-astra", result.used);
		check("tool calls are summarised", result.prompt.includes("[tool call edit"));
		check("thinking blocks are not sent", !result.prompt.includes("hidden"));
	}

	section("tool");
	{
		const state = load();
		const context = makeContext([FREE_ASTRA, FREE_SOL]);
		const result = await state.tools.ask_advisor.execute("call-1", { question: "safe?" }, undefined, undefined, context);
		check("tool returns advice", result.content?.[0]?.text === "advice", JSON.stringify(result).slice(0, 120));
		check("tool reports which advisor answered", result.details?.advisor === "free-pi/gpt-6.2-astra", JSON.stringify(result.details));
		const failing = makeContext([FREE_ASTRA], { fail: "429 slow down" });
		const failed = await state.tools.ask_advisor.execute("call-2", { question: "safe?" }, undefined, undefined, failing);
		check("tool reports failures as errors", failed.isError === true);
	}

	section("completion");
	{
		const state = load();
		const context = makeContext([FREE_ASTRA, FREE_SOL]);
		state.handlers.session_start({}, context);
		const labels = state.commands.advisor.getArgumentCompletions("").map((item) => item.label);
		check("lists use", labels.includes("use"), labels.join(","));
		check("lists set", labels.includes("set"), labels.join(","));
		const modelLabels = state.commands.advisor.getArgumentCompletions("set ").map((item) => item.label);
		check("set completes models", modelLabels.includes("gpt-6.2-astra"), modelLabels.join(","));
		check("set completes default", modelLabels.includes("default"), modelLabels.join(","));
	}
} finally {
	server.close();
	rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
	console.log(`failed: ${failures.join("; ")}`);
	process.exit(1);
}
