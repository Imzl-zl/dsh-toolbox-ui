import { registerHooks } from "node:module";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { runCli } from "@deepseek-ai/dsh/lib/bin.js";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region lib/types/office-engine.js
/** Resolve packaged Office engine manifests from their complete, unpacked resource directories. */
/**
* Locate the archive containing a packaged runtime.
* @param runtimeDir - Prepared or ASAR-contained runtime directory.
* @returns Parent archive path, or undefined for a prepared directory.
*/
function runtimeArchivePath(runtimeDir) {
	const parent = dirname(runtimeDir);
	return basename(parent) === "app.asar" ? parent : void 0;
}
/**
* Keep engine executable and resource paths usable by native child processes outside Electron.
* Hooks apply only to this thread; worker threads must install their own resolver.
* @param runtimeDir - Prepared or ASAR-contained dsh runtime directory.
* @returns Installed resolver for the Host lifetime, or undefined for a non-ASAR runtime.
*/
function installOfficeEngineResolution(runtimeDir) {
	if (runtimeArchivePath(runtimeDir) === void 0) return void 0;
	const root = realpathSync(runtimeDir);
	const archive = dirname(root);
	const source = pathToFileURL(join(root, "node_modules", "@deepseek-ai", "libreoffice-kit-")).href;
	const destination = pathToFileURL(join(`${archive}.unpacked`, relative(archive, root), "node_modules", "@deepseek-ai", "libreoffice-kit-")).href;
	return registerHooks({ resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		if (!resolved.url.startsWith("file:")) return resolved;
		const engineRequest = /^@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-/u.test(specifier);
		const engineTarget = /\/node_modules\/@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-[^/]+\//u.test(new URL(resolved.url).pathname);
		if (!engineRequest && !engineTarget) return resolved;
		const canonical = pathToFileURL(realpathSync(fileURLToPath(resolved.url))).href;
		if (!canonical.startsWith(source)) {
			if (canonical.startsWith(pathToFileURL(archive + "/").href)) throw new Error(`desktop Office engine resolved outside the runtime package directory: ${resolved.url}`);
			return resolved;
		}
		const physical = realpathSync(fileURLToPath(destination + canonical.slice(source.length)));
		return {
			...resolved,
			url: pathToFileURL(physical).href
		};
	} });
}
//#endregion
//#region lib/types/windows-cli-signals.js
var windows_cli_signals_exports = /* @__PURE__ */ __exportAll({ installWindowsCliSignals: () => installWindowsCliSignals });
/** Deliver console interrupts to CLI listeners in Electron's Windows Node mode. */
/**
* Register the CLI process's Windows console handler.
* Koffi queues callbacks from the console thread onto the JavaScript thread.
* The registration lasts until process exit; unknown events retain native handling.
* @returns Completion once the console handler is registered.
*/
async function installWindowsCliSignals() {
	const { default: koffi } = await import("koffi");
	const kernel = koffi.load("kernel32.dll");
	const type = koffi.proto("int __stdcall DshCliConsoleHandler(uint32_t event)");
	const handler = koffi.register((event) => {
		if (event === 0) return Number(process.emit("SIGINT"));
		if (event === 1) return Number(process.emit("SIGBREAK"));
		return 0;
	}, koffi.pointer(type));
	if (!kernel.func("int __stdcall SetConsoleCtrlHandler(DshCliConsoleHandler *handler, int add)")(handler, 1)) {
		koffi.unregister(handler);
		throw new Error("desktop CLI: cannot register the Windows console handler");
	}
}
var init_windows_cli_signals = __esmMin((() => {}));
//#endregion
//#region lib/types/cli.js
/** Public dsh commands using the immutable runtime carried by the Desktop installation. */
/**
* Run the ordinary CLI with Desktop's bundled package manager and reserved-profile plugin access.
* @param runtimeDir - Prepared or ASAR-contained production DSH package tree.
* @param supportDir - Physical Desktop runtime directory containing the primary-runtime payload and Node launchers.
* @returns Completion of the selected CLI command; profile plugins own their process lifetime.
*/
async function runDesktopCli(runtimeDir, supportDir) {
	installOfficeEngineResolution(runtimeDir);
	await runCli({
		manageDesktopProfile: true,
		packageManager: {
			command: process.execPath,
			args: ["--expose-internals", join(supportDir, "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.mjs")],
			env: {
				ELECTRON_RUN_AS_NODE: "1",
				DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
				PATH: `${join(supportDir, "bin")}${delimiter}${process.env.PATH ?? ""}`
			}
		}
	});
}
if (import.meta.main) {
	if (process.platform === "win32") {
		const { installWindowsCliSignals } = await Promise.resolve().then(() => (init_windows_cli_signals(), windows_cli_signals_exports));
		await installWindowsCliSignals();
	}
	const runtimeDir = resolve(import.meta.dirname, "../../../..");
	await runDesktopCli(runtimeDir, join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), "runtime"));
}
//#endregion
export { runDesktopCli };
