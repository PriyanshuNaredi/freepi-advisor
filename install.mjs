#!/usr/bin/env node
/**
 * Copy advisor.ts into the agent's extensions folder.
 *
 *   node install.mjs                 # detect the agent directory
 *   node install.mjs --dir <path>    # or name it explicitly
 *
 * The agent directory is $PI_CODING_AGENT_DIR when set, otherwise the first of
 * ~/.free-pi/agent or ~/.pi/agent that exists. Restart free-pi/pi afterwards.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const source = join(import.meta.dirname ?? resolve(new URL(".", import.meta.url).pathname), "advisor.ts");

function argValue(flag) {
	const index = process.argv.indexOf(flag);
	return index > -1 ? process.argv[index + 1] : undefined;
}

function detectAgentDir() {
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
	for (const candidate of [join(homedir(), ".free-pi", "agent"), join(homedir(), ".pi", "agent")]) {
		if (existsSync(candidate)) return candidate;
	}
	return join(homedir(), ".free-pi", "agent");
}

const agentDir = resolve(argValue("--dir") ?? detectAgentDir());
const extensionsDir = join(agentDir, "extensions");
const target = join(extensionsDir, "advisor.ts");

if (!existsSync(source)) {
	console.error(`Cannot find advisor.ts next to this script (${source}).`);
	process.exit(1);
}

mkdirSync(extensionsDir, { recursive: true });
copyFileSync(source, target);

const lines = readFileSync(target, "utf8").split("\n").length;
console.log(`advisor.ts -> ${target} (${lines} lines)`);
console.log(`Agent directory: ${agentDir}`);
console.log("Restart free-pi (or pi) to load the extension, then run /advisor model.");
if (!process.env.PI_CODING_AGENT_DIR && !existsSync(agentDir)) {
	console.log("Note: that agent directory did not exist before; check that it matches your installation.");
}
