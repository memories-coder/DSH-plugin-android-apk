// dsh-plugin-android-apk — core build orchestration.
//
// Given an Android Gradle project folder, this module:
//   1. detects the project shape (settings.gradle / build.gradle, wrapper),
//   2. ensures a JDK (system java >= 11, else downloads Temurin into the
//      download folder),
//   3. ensures an Android SDK (ANDROID_HOME / local.properties / default
//      location, else downloads cmdline-tools + platform-tools +
//      build-tools + platform into the download folder),
//   4. ensures Gradle (project wrapper when usable, else a downloaded
//      distribution), and
//   5. runs `assemble<Variant>` and copies the produced APKs to the APK
//      output folder.
//
// Every artifact that has to be fetched is stored under `downloadDir`
// (default `<session workspace>/.android-build`), so nothing pollutes the
// user profile or home directory. GRADLE_USER_HOME is redirected there too,
// keeping wrapper distributions and dependency caches inside the workspace.
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
	commandlineToolsUrls,
	extractZip,
	gradleDownloadUrls,
	jdkDownloadUrls,
	tryMirrors
} from "./download.js";

const DEFAULT_COMPILE_SDK = 34;
const DEFAULT_GRADLE_VERSION = "8.9";
const MIN_SYSTEM_JAVA_MAJOR = 11;
const MAX_TAIL_BYTES = 300_000;

/** Ring buffer keeping only the last `max` characters of streamed output. */
class TailBuffer {
	constructor(max) {
		this.max = max;
		this.buf = "";
	}
	push(chunk) {
		this.buf += chunk;
		if (this.buf.length > this.max * 2) this.buf = this.buf.slice(-this.max);
	}
	text() {
		return this.buf.slice(-this.max);
	}
}

/** Kill a process tree (Windows taskkill first, then plain kill). */
function killTree(pid) {
	if (!pid) return;
	try {
		spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
	} catch {
		// ignore
	}
	try {
		process.kill(pid);
	} catch {
		// ignore
	}
}

/** Quote an argument for use inside a `cmd.exe /c` command line. */
function cmdQuote(arg) {
	// Wrap in double quotes and escape any inner double quotes (cmd treats
	// them literally after doubling when not followed by a special char).
	return `"${String(arg).replace(/"/g, '\\"')}"`;
}

/**
 * Run one command, collecting tail-capped stdout/stderr. Returns
 * `{ code, stdout, stderr, aborted }`. The child is killed when `signal`
 * aborts, and the promise settles once the child exits.
 *
 * On Windows, batch files (.bat/.cmd) are executed through `cmd.exe /d /s /c`
 * with `windowsVerbatimArguments`, and the codepage is switched to UTF-8
 * (`chcp 65001`) so non-ASCII (CJK) paths inside the command don't garble the
 * bytes. Non-batch executables are spawned directly with argv — no `shell`
 * mode anywhere, so the `DEP0190` "passing args with shell" warning never
 * fires and nothing is concatenated unquoted.
 */
function runCommand(command, args, { cwd, env, signal, maxTail = MAX_TAIL_BYTES } = {}) {
	return new Promise((settle) => {
		const isBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
		let spawnCmd = command;
		let spawnArgs = args;
		let options = { cwd, env, windowsHide: true };
		if (isBatch) {
			const inner = `${cmdQuote(command)}${args.length > 0 ? " " + args.map(cmdQuote).join(" ") : ""}`;
			spawnCmd = "cmd.exe";
			spawnArgs = ["/d", "/s", "/c", `chcp 65001>nul & ${inner}`];
			options.windowsVerbatimArguments = true;
		}
		const child = spawn(spawnCmd, spawnArgs, options);
		const stdout = new TailBuffer(maxTail);
		const stderr = new TailBuffer(maxTail);
		const onAbort = () => {
			killTree(child.pid);
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		child.stdout?.on("data", (chunk) => stdout.push(chunk.toString()));
		child.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));
		child.on("error", (err) => {
			if (signal) signal.removeEventListener("abort", onAbort);
			settle({ code: -1, error: err.message, stdout: stdout.text(), stderr: stderr.text(), aborted: signal?.aborted ?? false });
		});
		child.on("close", (code) => {
			if (signal) signal.removeEventListener("abort", onAbort);
			settle({ code, stdout: stdout.text(), stderr: stderr.text(), aborted: signal?.aborted ?? false });
		});
	});
}

/** Parse the java major version out of `java -version` output. */
export function parseJavaMajor(text) {
	const m = /version\s+"(?:1\.)?(\d+)/.exec(text ?? "");
	return m ? Number(m[1]) : null;
}

/** Locate a usable system JDK. Returns `{ home, major }` or null. */
async function findSystemJava() {
	if (process.env.JAVA_HOME) {
		const exe = join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java");
		if (existsSync(exe)) {
			const r = runCommand(exe, ["-version"], {});
			const major = parseJavaMajor(r.stdout + r.stderr);
			if (major) return { home: process.env.JAVA_HOME, major };
		}
	}
	const r = runCommand("java", ["-version"], {});
	const major = parseJavaMajor(r.stdout + r.stderr);
	if (major) {
		const exe = spawnSync(process.platform === "win32" ? "where" : "which", ["java"], { encoding: "utf8" })
			.stdout.split(/\r?\n/)[0];
		const home = exe ? dirname(dirname(exe)) : null;
		return { home, major, command: "java" };
	}
	return null;
}

/** Download + extract a Temurin JDK. Returns the java home directory. */
async function ensureDownloadedJdk(downloadDir, { jdkMajor, signal, log }) {
	const jdkRoot = join(downloadDir, "jdk");
	const zipPath = join(downloadDir, "jdk.zip");
	const urls = await jdkDownloadUrls(jdkMajor);
	log(`[jdk] downloading Temurin JDK ${jdkMajor} for Windows x64 …`);
	const used = await tryMirrors(urls, zipPath, { signal });
	log(`[jdk] downloaded from ${used}`);
	await mkdir(jdkRoot, { recursive: true });
	await extractZip(zipPath, jdkRoot);
	await rm(zipPath, { force: true }).catch(() => {});
	const entries = await readdir(jdkRoot);
	let javaHome = null;
	for (const entry of entries) {
		const candidate = join(jdkRoot, entry);
		if (existsSync(join(candidate, "bin", "java.exe"))) {
			javaHome = candidate;
			break;
		}
	}
	if (!javaHome) throw new Error("JDK archive extracted but no bin/java.exe found");
	log(`[jdk] ready at ${javaHome}`);
	return javaHome;
}

/** Ensure a JDK is available. Returns `{ home, source }`. */
async function ensureJdk(downloadDir, { jdkMajor, signal, log }) {
	const system = await findSystemJava();
	if (system && system.major >= MIN_SYSTEM_JAVA_MAJOR) {
		log(`[jdk] using system java ${system.major} at ${system.home ?? "PATH"}`);
		return { home: system.home ?? null, source: "system" };
	}
	const home = await ensureDownloadedJdk(downloadDir, { jdkMajor, signal, log });
	return { home, source: "downloaded" };
}

/** Parse `sdk.dir` from a local.properties file, if present. */
async function readSdkDirFromLocalProperties(projectDir) {
	try {
		const text = await readFile(join(projectDir, "local.properties"), "utf8");
		const m = /^\s*sdk\.dir\s*=\s*(.+)$/m.exec(text);
		if (m) {
			return m[1].trim().replace(/\\:/g, ":").replace(/\\\\/g, "\\");
		}
	} catch {
		// no local.properties
	}
	return null;
}

/** Detect the project's compileSdk by scanning build.gradle files. */
async function detectCompileSdk(projectDir) {
	const dirs = [projectDir];
	try {
		for (const entry of await readdir(projectDir, { withFileTypes: true })) {
			if (entry.isDirectory() && !/^[._]/.test(entry.name) && !["build", "gradle", "node_modules", ".gradle"].includes(entry.name)) {
				dirs.push(join(projectDir, entry.name));
			}
		}
	} catch {
		// unreadable — proceed with project dir only
	}
	for (const dir of dirs) {
		let names = [];
		try {
			names = await readdir(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (/^build\.gradle(\.kts)?$/.test(name)) {
				const text = await readFile(join(dir, name), "utf8").catch(() => "");
				const m = /compileSdk(?:Version)?\s*(?:=|\s)\s*(\d+)/.exec(text);
				if (m) return Number(m[1]);
			}
		}
	}
	return null;
}

/** Project shape detection. */
async function detectProject(projectDir) {
	let names = [];
	try {
		names = await readdir(projectDir);
	} catch {
		throw new Error(`project folder not found or unreadable: ${projectDir}`);
	}
	const lower = names.map((n) => n.toLowerCase());
	const hasSettings = lower.includes("settings.gradle") || lower.includes("settings.gradle.kts");
	const hasRootBuild = lower.includes("build.gradle") || lower.includes("build.gradle.kts");
	if (!hasSettings && !hasRootBuild) {
		throw new Error(
			`${projectDir} does not look like a Gradle project (no settings.gradle / settings.gradle.kts / build.gradle)`
		);
	}
	const hasWrapperScript = lower.includes("gradlew.bat") || lower.includes("gradlew");
	let wrapperJar = false;
	let wrapperVersion = null;
	try {
		const props = await readFile(join(projectDir, "gradle", "wrapper", "gradle-wrapper.properties"), "utf8");
		const m = /gradle-(\d+(?:\.\d+){1,2})-.*?\.zip/.exec(props);
		wrapperVersion = m ? m[1] : null;
		await stat(join(projectDir, "gradle", "wrapper", "gradle-wrapper.jar"));
		wrapperJar = true;
	} catch {
		// no wrapper
	}
	return { hasSettings, hasRootBuild, hasWrapperScript, wrapperJar, wrapperVersion };
}

/** True when `path` contains at least one non-ASCII character. */
function hasNonAscii(path) {
	return /[^\x00-\x7F]/.test(path);
}

/**
 * AGP refuses to build projects whose path contains non-ASCII characters on
 * Windows (AGP path check, b.android.com/95744). When the project lives under
 * such a path, append `android.overridePathCheck=true` to the project's
 * gradle.properties so the build carries on.
 */
async function ensureGradlePropertiesAllowNonAsciiPath(projectDir, service) {
	// no-op unless the path actually contains non-ASCII bytes
	if (!hasNonAscii(projectDir)) return;
	const propsPath = join(projectDir, "gradle.properties");
	let existing = "";
	try {
		existing = await readFile(propsPath, "utf8");
	} catch {
		// file does not exist yet
	}
	if (/android\.overridePathCheck\s*=/.test(existing)) return; // already set
	const line = "\n# Added by dsh-plugin-android-apk: build under a non-ASCII path\nandroid.overridePathCheck=true\n";
	await writeFile(propsPath, existing.replace(/\n*$/, "") + line);
	service.log("[build] project path contains non-ASCII characters — added android.overridePathCheck=true to gradle.properties");
}

/** Write the standard SDK license acceptance files (avoids interactive prompts). */
async function writeSdkLicenses(sdkDir) {
	const licensesDir = join(sdkDir, "licenses");
	await mkdir(licensesDir, { recursive: true });
	await writeFile(join(licensesDir, "android-sdk-license"), [
		"8933bad161af4178b1185d1a37fbf41ea5269c55",
		"d56f5187479451eabf01fb78af6dfcb131a6481e",
		"24333f8a63b6825ea9c5514f83c2829b004d1fee",
		""
	].join("\n"));
	await writeFile(join(licensesDir, "android-sdk-preview-license"), "84831b9409646a918e30573bab4c9c91346d8abd\n");
}

/** Run sdkmanager.bat with the given package args. */
async function runSdkmanager(sdkDir, args, { javaHome, signal }) {
	const bat = join(sdkDir, "cmdline-tools", "latest", "bin", "sdkmanager.bat");
	const env = {
		...process.env,
		JAVA_HOME: javaHome ?? process.env.JAVA_HOME ?? ""
	};
	// Spawn the .bat directly with argv (Windows uses cmd.exe to interpret it)
	// rather than gluing a hand-quoted string through `cmd.exe /c`, which is
	// fragile for paths containing spaces or non-ASCII (CJK) characters.
	return runCommand(bat, args, { cwd: sdkDir, env, signal, maxTail: 400_000 });
}

/** Pick best build-tools and platform versions from `sdkmanager --list` output. */
export function pickSdkPackages(listText, compileSdk) {
	const re = /(?:^|[\s]|>)(build-tools;[\d.]+|platforms;android-\d+)\s*\|\s*([^\s|]+)/gm;
	const buildTools = [];
	const platforms = [];
	let match;
	while ((match = re.exec(listText)) !== null) {
		const [full, pkg] = match;
		if (pkg.startsWith("build-tools;")) buildTools.push(pkg.slice("build-tools;".length));
		else if (pkg.startsWith("platforms;android-")) platforms.push(Number(pkg.slice("platforms;android-".length)));
	}
	const toParts = (v) => v.split(".").map(Number);
	const cmpVersion = (a, b) => {
		const pa = toParts(a);
		const pb = toParts(b);
		for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			const da = pa[i] ?? 0;
			const db = pb[i] ?? 0;
			if (da !== db) return da - db;
		}
		return 0;
	};
	let buildToolsVersion = null;
	const sameMajor = buildTools.filter((v) => Number(v.split(".")[0]) === compileSdk);
	const pool = sameMajor.length > 0 ? sameMajor : buildTools;
	if (pool.length > 0) buildToolsVersion = pool.reduce((best, v) => (cmpVersion(v, best) > 0 ? v : best));
	let platform = null;
	if (platforms.includes(compileSdk)) platform = compileSdk;
	else {
		const usable = platforms.filter((p) => p >= compileSdk);
		platform = usable.length > 0 ? Math.min(...usable) : (platforms.length > 0 ? Math.max(...platforms) : compileSdk);
	}
	return { buildToolsVersion, platform };
}

/** Ensure an Android SDK; download one into `downloadDir` when nothing usable exists. */
async function ensureAndroidSdk(projectDir, downloadDir, { compileSdk, javaHome, signal, log }) {
	const localSdk = await readSdkDirFromLocalProperties(projectDir);
	const candidates = [localSdk, process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
	if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Android", "Sdk"));
	candidates.push(join(downloadDir, "android-sdk"));
	const usable = (dir) => {
		if (!dir || !existsSync(dir)) return false;
		if (!existsSync(join(dir, "platform-tools"))) return false;
		let hasPlatform = false;
		let hasBuildTools = false;
		try {
			for (const entry of readdirSyncSafe(join(dir, "platforms"))) if (/^android-/.test(entry)) hasPlatform = true;
			for (const entry of readdirSyncSafe(join(dir, "build-tools"))) hasBuildTools = true;
		} catch {
			return false;
		}
		return hasPlatform && hasBuildTools;
	};
	for (const dir of candidates) {
		if (dir && usable(dir)) {
			log(`[sdk] using existing Android SDK at ${dir}`);
			return { sdkDir: dir, source: "found" };
		}
	}
	const sdkDir = join(downloadDir, "android-sdk");
	log(`[sdk] no usable Android SDK found — downloading commandline-tools into ${sdkDir}`);
	await mkdir(sdkDir, { recursive: true });
	const zipPath = join(downloadDir, "cmdline-tools.zip");
	const used = await tryMirrors(commandlineToolsUrls(), zipPath, { signal });
	log(`[sdk] commandline-tools downloaded from ${used}`);
	const tempExtract = join(downloadDir, "cmdline-tools-extract");
	await mkdir(tempExtract, { recursive: true });
	await extractZip(zipPath, tempExtract);
	await rm(zipPath, { force: true }).catch(() => {});
	const latestDir = join(sdkDir, "cmdline-tools", "latest");
	await mkdir(dirname(latestDir), { recursive: true });
	const inner = join(tempExtract, "cmdline-tools");
	if (existsSync(join(inner, "bin", "sdkmanager.bat"))) {
		await rm(latestDir, { recursive: true, force: true }).catch(() => {});
		await renameSafe(inner, latestDir);
	} else if (existsSync(join(tempExtract, "bin", "sdkmanager.bat"))) {
		await renameSafe(tempExtract, latestDir);
	} else {
		throw new Error("commandline-tools archive did not contain sdkmanager");
	}
	await rm(tempExtract, { recursive: true, force: true }).catch(() => {});
	await writeSdkLicenses(sdkDir);

	log("[sdk] querying available packages via sdkmanager --list …");
	const list = await runSdkmanager(sdkDir, ["--list"], { javaHome, signal });
	if (list.code !== 0) {
		throw new Error(`sdkmanager --list failed: ${list.stderr.slice(-2000)}`);
	}
	const { buildToolsVersion, platform } = pickSdkPackages(list.stdout + list.stderr, compileSdk);
	const packages = ["platform-tools"];
	if (platform !== null) packages.push(`platforms;android-${platform}`);
	if (buildToolsVersion !== null) packages.push(`build-tools;${buildToolsVersion}`);
	log(`[sdk] installing ${packages.join(", ")} …`);
	const install = await runSdkmanager(sdkDir, packages, { javaHome, signal });
	if (install.code !== 0) {
		throw new Error(`sdkmanager install failed (${install.stderr.slice(-2000) || install.stdout.slice(-2000)})`);
	}
	const sdkProps = `sdk.dir=${sdkDir.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}\n`;
	await writeFile(join(projectDir, "local.properties"), sdkProps, { flag: "wx" }).catch(() => {});
	log(`[sdk] ready at ${sdkDir} (platform android-${platform ?? "?"}, build-tools ${buildToolsVersion ?? "?"})`);
	return { sdkDir, source: "downloaded" };
}

function readdirSyncSafe(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Rename, tolerating a target that already exists (Windows rename quirk). */
async function renameSafe(from, to) {
	try {
		await rename(from, to);
	} catch {
		await rm(to, { recursive: true, force: true }).catch(() => {});
		await rename(from, to);
	}
}

/** Ensure a Gradle launcher. Returns `{ command, source, gradleHome }`. */
async function ensureGradle(projectDir, downloadDir, det, { gradleVersion, signal, log, forceDownload = false } = {}) {
	if (!forceDownload && det.wrapperJar && det.hasWrapperScript) {
		const command = join(projectDir, process.platform === "win32" ? "gradlew.bat" : "gradlew");
		log(`[gradle] using project wrapper ${command}`);
		return { command, source: "wrapper", gradleHome: null };
	}
	const version = det.wrapperVersion ?? gradleVersion ?? DEFAULT_GRADLE_VERSION;
	log(`[gradle] no usable wrapper — downloading Gradle ${version} distribution`);
	const gradleHome = join(downloadDir, "gradle", `gradle-${version}`);
	if (!existsSync(join(gradleHome, "bin", process.platform === "win32" ? "gradle.bat" : "gradle"))) {
		const zipPath = join(downloadDir, "gradle.zip");
		const used = await tryMirrors(gradleDownloadUrls(version), zipPath, { signal });
		log(`[gradle] distribution downloaded from ${used}`);
		await extractZip(zipPath, dirname(gradleHome));
		await rm(zipPath, { force: true }).catch(() => {});
	}
	const command = join(gradleHome, "bin", process.platform === "win32" ? "gradle.bat" : "gradle");
	log(`[gradle] using downloaded Gradle at ${command}`);
	return { command, source: "downloaded", gradleHome };
}

/** Find produced APKs under the build/outputs/apk folder of any module. */
async function findApks(projectDir) {
	const out = [];
	const walk = async (dir, depth) => {
		if (depth > 10) return;
		let entries = [];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (entry.name === ".gradle" || entry.name === "node_modules") continue;
				await walk(join(dir, entry.name), depth + 1);
			} else if (entry.name.endsWith(".apk") && /[\\/]build[\\/]outputs[\\/]apk[\\/]/.test(join(dir, entry.name).slice(projectDir.length))) {
				const full = join(dir, entry.name);
				try {
					const info = await stat(full);
					out.push({ path: full, bytes: info.size });
				} catch {
					// skip unreadable
				}
			}
		}
	};
	await walk(projectDir, 0);
	return out;
}

/** Copy APKs into `apkOutputDir`; returns copied paths. */
async function copyApks(apks, apkOutputDir, { log }) {
	await mkdir(apkOutputDir, { recursive: true });
	const copied = [];
	for (const apk of apks) {
		const dest = join(apkOutputDir, basename(apk.path));
		try {
			await copyFile(apk.path, dest);
			copied.push(dest);
		} catch (err) {
			log(`[apk] copy failed for ${apk.path}: ${err.message}`);
		}
	}
	return copied;
}

/**
 * ASCII-staging support.
 *
 * On Windows, AGP's AAPT2 cannot read SDK platform jars (android.jar) when
 * the path contains non-ASCII (e.g. CJK) characters — it fails with
 * "Failed to stat file .../platforms/android-XX/android.jar". `android.overridePathCheck`
 * lets AGP start, but AAPT2 still cannot resolve resources.
 *
 * When the effective project path or SDK directory contains non-ASCII
 * characters, we stage a copy of the project and the Android SDK under an
 * ASCII temp root (default `os.tmpdir()`), build there, then copy the
 * produced APKs back into the caller's APK output folder (inside the
 * workspace). The staged SDK is cached across runs (a `<stamp>` keyed by the
 * source SDK path and platform version is recorded in a marker file), so
 * downloads are not repeated.
 */

/** Pick an ASCII-usable temp root: prefer os.tmpdir() if pure ASCII, else a subdir of `downloadDir`. */
function pickAsciiRoot(downloadDir) {
	const root = tmpdir();
	if (!hasNonAscii(root)) return join(root, "dsh-android-build");
	return join(downloadDir, "build");
}

/** Copy only the parts of a path that exist and are non-empty. */
async function copyPathIfPresent(src, dst) {
	if (!existsSync(src)) return { copied: false, bytes: 0 };
	let bytes = 0;
	await mkdir(dst, { recursive: true });
	await cp(src, dst, { recursive: true, force: true });
	for (const f of await readdir(dst, { withFileTypes: true })) {
		if (f.isFile()) {
			try {
				bytes += (await stat(join(dst, f.name))).size;
			} catch {
				// ignore
			}
		}
	}
	return { copied: true, bytes };
}

/** The SKU string that identifies a given SDK layout for staging cache reuse. */
function sdkSku(sdkDir, platform) {
	try {
		const props = readFileSyncSafe(join(sdkDir, "cmdline-tools", "latest", "bin", "sdkmanager.bat"));
		return `platform;${platform}:bt:${existsSync(join(sdkDir, "build-tools")) ? "y" : "n"}`;
	} catch {
		return `platform;${platform}`;
	}
}

/**
 * Ensure an ASCII SDK copy for `sdkDir`+`platform` exists in `asciiDir/android-sdk`.
 * Returns the staged SDK path, or `null` when nothing got staged (already ascii).
 */
async function ensureStagedSdk(asciiRoot, sdkDir, platform, { signal, log }) {
	const marker = join(asciiRoot, "android-sdk", ".dsh-staged-sku");
	const sku = sdkSku(sdkDir, platform);
	if (existsSync(marker)) {
		try {
			const { default: ffs } = await import("node:fs");
			if (ffs.readFileSync(marker, "utf8").trim() === sku) {
				log("[stage] SDK already staged as ASCII copy");
				return join(asciiRoot, "android-sdk");
			}
		} catch {
			// fall through and restage
		}
	}
	log("[stage] project path contains non-ASCII characters — staging SDK + project to an ASCII build dir for AAPT2");
	const stagedSdk = join(asciiRoot, "android-sdk");
	await rm(stagedSdk, { recursive: true, force: true }).catch(() => {});
	for (const sub of ["platforms", "build-tools", "platform-tools", "cmdline-tools", "licenses"]) {
		await copyPathIfPresent(join(sdkDir, sub), join(stagedSdk, sub));
	}
	await writeFile(marker, sku).catch(() => {});
	return stagedSdk;
}

/**
 * Stage the project at `dst` under `asciiRoot/sample`; returns dst path.
 * Also writes a local.properties pointing at the staged SDK.
 */
async function stageProject(asciiRoot, projectDir, stagedSdk) {
	const dst = join(asciiRoot, "sample-app");
	await rm(dst, { recursive: true, force: true }).catch(() => {});
	await cp(projectDir, dst, { recursive: true, force: true });
	await writeFile(join(dst, "local.properties"), `sdk.dir=${stagedSdk.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}\n`);
	return dst;
}

/** Resolve effective build paths, staging onto an ASCII root when needed. */
async function resolveBuildContext({ project, sdkDir, downloadDir, apkOutputDir, compileSdk, log }) {
	const projectAscii = !hasNonAscii(project);
	const sdkAscii = !hasNonAscii(sdkDir);
	if (projectAscii && sdkAscii) {
		return { project, sdkDir, usedStaging: false, apkOutputDir };
	}
	const root = pickAsciiRoot(downloadDir);
	const stagedSdk = await ensureStagedSdk(root, sdkDir, compileSdk, { log });
	const stagedProject = await stageProject(root, project, stagedSdk);
	log(`[stage] using ASCII build dir: ${root}\n[stage] staged project → ${stagedProject}\n[stage] staged SDK → ${stagedSdk}`);
	return { project: stagedProject, sdkDir: stagedSdk, usedStaging: true, apkOutputDir, originalApkOutput: apkOutputDir };
}

function readFileSyncSafe(p) {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return "";
	}
}

/**
 * The build entry point used by the tool's `execute`.
 * Returns the canonical result object declared by the tool output schema.
 */
export async function buildApk(args, exec, config) {
	const started = Date.now();
	const logLines = [];
	const log = (msg) => logLines.push(msg);
	const signal = exec.signal;
	const outcome = {
		ok: false,
		message: "",
		apks: [],
		downloadsDir: "",
		jdk: "",
		sdk: "",
		gradle: "",
		logTail: "",
		durationMs: 0
	};
	try {
		const workspace = exec.agent?.session?.header?.cwd ?? process.cwd();
		const project = isAbsolute(args.project) ? args.project : resolve(workspace, args.project);
		const s = (v, fb) => (v && v !== "" ? v : fb);
		const downloadDir = resolve(workspace, s(args.downloadDir, s(config.downloadRoot, ".android-build")));
		const apkOutputDir = resolve(workspace, s(args.apkOutputDir, s(config.apkOutputDir, "apk")));
		const jdkMajor = config.jdkMajor ?? 17;
		const gradleVersion = s(args.gradleVersion, s(config.gradleVersion, DEFAULT_GRADLE_VERSION));
		outcome.downloadsDir = downloadDir;

		const det = await detectProject(project);
		if (!det.hasSettings && !det.hasRootBuild) {
			throw new Error(`${project} does not look like an Android Gradle project (no settings.gradle / build.gradle)`);
		}
		await ensureGradlePropertiesAllowNonAsciiPath(project, { log });
		const compileSdk = args.compileSdk ?? (config.compileSdk && config.compileSdk > 0 ? config.compileSdk : null) ?? (await detectCompileSdk(project)) ?? DEFAULT_COMPILE_SDK;
		log(`[project] ${project}`);
		log(`[project] compileSdk = ${compileSdk}`);

		const jdk = await ensureJdk(downloadDir, { jdkMajor, signal, log });
		outcome.jdk = `${jdk.source}:${jdk.home ?? "PATH"}`;

		const sdk = await ensureAndroidSdk(project, downloadDir, { compileSdk, javaHome: jdk.home, signal, log });
		outcome.sdk = `${sdk.source}:${sdk.sdkDir}`;

		// If the project or SDK path contains non-ASCII characters, staging onto
		// an ASCII temp root is required for AAPT2 to resolve resources.
		const buildCtx = await resolveBuildContext({
			project,
			sdkDir: sdk.sdkDir,
			downloadDir,
			apkOutputDir,
			compileSdk,
			log
		});
		const buildProject = buildCtx.project;
		const buildSdk = buildCtx.sdkDir;

		const det2 = buildCtx.usedStaging ? await detectProject(buildProject) : det;
		const gradle = await ensureGradle(buildProject, downloadDir, det2, {
			gradleVersion,
			signal,
			log,
			// under staging the build runs from an ASCII copy; use a downloaded
			// distribution (never the wrapper jar, whose version may be stale)
			// for reliability.
			forceDownload: buildCtx.usedStaging
		});
		outcome.gradle = gradle.source === "wrapper" ? `wrapper:${gradle.command}` : `downloaded:${gradle.command}`;

		const variant = (args.variant ?? config.defaultVariant ?? "debug").trim().toLowerCase();
		if (!/^[a-z0-9]+$/.test(variant)) throw new Error(`invalid variant: ${variant}`);
		const task = `assemble${variant[0].toUpperCase()}${variant.slice(1)}`;
		const gradleArgs = [task, "--no-daemon", "--console=plain"];
		if (args.clean === true) gradleArgs.unshift("--clean");

		const env = { ...process.env };
		if (jdk.home) env.JAVA_HOME = jdk.home;
		env.ANDROID_HOME = buildSdk;
		env.ANDROID_SDK_ROOT = buildSdk;
		env.GRADLE_USER_HOME = join(downloadDir, "gradle-user-home");
		const pathBits = [];
		if (jdk.home) pathBits.push(join(jdk.home, "bin"));
		pathBits.push(join(buildSdk, "platform-tools"));
		env.PATH = `${pathBits.join(sep === "/" ? ":" : ";")}${sep === "/" ? ":" : ";"}${process.env.PATH ?? ""}`;

		log(`[build] running: ${gradle.command} ${gradleArgs.join(" ")} (cwd ${buildProject})`);
		const result = await runCommand(gradle.command, gradleArgs, { cwd: buildProject, env, signal });
		const combined = `${result.stdout}\n${result.stderr}`.trim();
		log(`[build] gradle exit code: ${result.code}${result.aborted ? " (aborted)" : ""}`);
		if (result.aborted) {
			throw new Error("build aborted by caller");
		}
		if (result.code !== 0) {
			throw new Error(`gradle build failed with exit code ${result.code}:\n${combined.slice(-4000)}`);
		}
		const apks = await findApks(buildProject);
		if (apks.length === 0) {
			throw new Error(`build succeeded but no APK found under ${buildProject}\\**\\build\\outputs\\apk`);
		}
		const copied = await copyApks(apks, apkOutputDir, { log });
		outcome.apks = apks.map((apk, i) => ({
			path: apk.path,
			bytes: apk.bytes,
			copiedTo: copied[i],
			staged: buildCtx.usedStaging === true
		}));
		outcome.ok = true;
		outcome.message = `built ${apks.length} APK(s)${copied.length > 0 ? `, copied to ${apkOutputDir}` : ""}${buildCtx.usedStaging ? " (built in an ASCII temp dir because the project path contains non-ASCII characters)" : ""}`;
		log(`[apk] ${apks.map((a) => a.path).join("\n[apk] ")}`);
	} catch (err) {
		outcome.message = err.message ?? String(err);
		log(`[error] ${outcome.message}`);
	}
	outcome.durationMs = Date.now() - started;
	outcome.logTail = logLines.join("\n").slice(-MAX_TAIL_BYTES);
	return outcome;
}
