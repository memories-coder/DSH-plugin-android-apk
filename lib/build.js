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
import { accessSync, chmodSync, constants as fsConstants, existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
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
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		} catch {
			// ignore
		}
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
		let child;
		try {
			child = spawn(spawnCmd, spawnArgs, options);
		} catch (err) {
			// invalid command / arguments — settle instead of throwing
			settle({ code: -1, error: err.message, stdout: "", stderr: err.message, aborted: signal?.aborted ?? false });
			return;
		}
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
			const r = await runCommand(exe, ["-version"], {});
			const major = parseJavaMajor((r.stdout ?? "") + (r.stderr ?? ""));
			if (major) return { home: process.env.JAVA_HOME, major };
		}
	}
	const r = await runCommand("java", ["-version"], {});
	const major = parseJavaMajor((r.stdout ?? "") + (r.stderr ?? ""));
	if (major) {
		const exe = (spawnSync(process.platform === "win32" ? "where" : "which", ["java"], { encoding: "utf8" }).stdout ?? "")
			.split(/\r?\n/)[0]
			?.trim();
		const home = exe ? dirname(dirname(exe)) : null;
		return { home, major, command: "java" };
	}
	return null;
}

/** Java launcher name for the current platform. */
const JAVA_BIN = process.platform === "win32" ? "java.exe" : "java";

/** Run `java -version` for a candidate home; returns the major version or null. */
async function probeJdk(home, { signal } = {}) {
	if (!home) return null;
	const exe = join(home, "bin", JAVA_BIN);
	if (!existsSync(exe)) return null;
	const r = await runCommand(exe, ["-version"], { signal });
	return parseJavaMajor((r.stdout ?? "") + (r.stderr ?? ""));
}

/**
 * Find the best JDK under `root` (one directory level) whose major version is
 * at least `minMajor`. Scans every candidate so a leftover older download can
 * never shadow a newer one.
 */
async function findBestJdkUnder(root, minMajor = 0, { signal } = {}) {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	let best = null;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const candidate = join(root, entry.name);
		if (!existsSync(join(candidate, "bin", JAVA_BIN))) continue;
		const major = await probeJdk(candidate, { signal });
		if (!major || major < minMajor) continue;
		if (!best || major > best.major) best = { home: candidate, major };
	}
	return best;
}

/** Throttled download progress logging (one line per ~32MB). */
function progressLogger(label, log) {
	let last = 0;
	return (received, total) => {
		if (received - last < 32 * 1024 * 1024 && !(total > 0 && received >= total)) return;
		last = received;
		const mb = (n) => (n / 1024 / 1024).toFixed(0);
		log(`[dl] ${label}: ${mb(received)}MB${total > 0 ? ` / ${mb(total)}MB` : ""}`);
	};
}

/** Download + extract a Temurin JDK. Returns the java home directory. */
async function ensureDownloadedJdk(downloadDir, { jdkMajor, minMajor = jdkMajor, signal, log }) {
	const jdkRoot = join(downloadDir, "jdk");
	await mkdir(jdkRoot, { recursive: true });

	// Reuse a JDK downloaded by an earlier run — otherwise every tool call
	// would pull ~180MB again whenever the host has no usable system java.
	const cached = await findBestJdkUnder(jdkRoot, minMajor, { signal });
	if (cached) {
		log(`[jdk] reusing downloaded JDK ${cached.major} at ${cached.home}`);
		return cached.home;
	}

	const zipPath = join(downloadDir, `jdk-${process.pid}-${Date.now()}.zip`);
	const urls = await jdkDownloadUrls(jdkMajor);
	log(`[jdk] downloading Temurin JDK ${jdkMajor} (${process.platform}/${process.arch}) …`);
	const used = await tryMirrors(urls, zipPath, { signal, onProgress: progressLogger("jdk", log) });
	log(`[jdk] downloaded from ${used}`);
	await extractZip(zipPath, jdkRoot);
	await rm(zipPath, { force: true }).catch(() => {});

	const found = await findBestJdkUnder(jdkRoot, minMajor, { signal });
	if (!found) throw new Error(`JDK archive extracted but no usable bin/${JAVA_BIN} (Java ${minMajor}+) found`);
	log(`[jdk] ready at ${found.home} (Java ${found.major})`);
	return found.home;
}

/**
 * Ensure a JDK. Returns `{ home, major, source }`.
 * `required` is the minimum Java major version the project's toolchain
 * (AGP / Gradle) actually needs — a system Java 11 is useless for AGP 8.
 */
async function ensureJdk(downloadDir, { jdkMajor, required = MIN_SYSTEM_JAVA_MAJOR, signal, log }) {
	const system = await findSystemJava();
	if (system && system.major >= required) {
		log(`[jdk] using system java ${system.major} at ${system.home ?? "PATH"}`);
		return { home: system.home ?? null, major: system.major, source: "system" };
	}
	if (system) log(`[jdk] system java ${system.major} at ${system.home ?? "PATH"} is too old (need ${required})`);
	const want = Math.max(jdkMajor, required);
	if (want !== jdkMajor) log(`[jdk] raising requested JDK ${jdkMajor} → ${want} to satisfy the toolchain requirement`);
	const home = await ensureDownloadedJdk(downloadDir, { jdkMajor: want, minMajor: want, signal, log });
	const major = (await probeJdk(home, { signal })) ?? want;
	return { home, major, source: "downloaded" };
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
	// version-catalog style projects: compileSdk = "34" in gradle/libs.versions.toml
	const toml = await readFile(join(projectDir, "gradle", "libs.versions.toml"), "utf8").catch(() => "");
	const tm = /^\s*compileSdk\s*=\s*"?(\d+)"?/m.exec(toml);
	if (tm) return Number(tm[1]);
	return null;
}

/** Compare dotted versions: `a < b`. Non-numeric parts compare as 0. */
function versionLt(a, b) {
	const pa = String(a).split(".").map((n) => Number(n) || 0);
	const pb = String(b).split(".").map((n) => Number(n) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return da < db;
	}
	return false;
}

/** Lowest Gradle version that supports running on each Java major version. */
const GRADLE_MIN_FOR_JAVA = [
	[17, "7.3"],
	[18, "7.5"],
	[19, "7.6"],
	[20, "8.3"],
	[21, "8.5"],
	[22, "8.8"],
	[23, "8.10"]
];

/** True when a Gradle of `gradleVersion` can run on `javaMajor`. */
export function isGradleRunnableOn(gradleVersion, javaMajor) {
	if (!gradleVersion || !javaMajor) return true;
	for (const [java, min] of GRADLE_MIN_FOR_JAVA) {
		if (javaMajor >= java && versionLt(gradleVersion, min)) return false;
	}
	return true;
}

/**
 * Minimum Java major version the project's toolchain needs.
 * AGP 8.x requires Java 17 (AGP 7.x requires 11); Gradle 8.x distributions
 * also expect a modern JDK. Returns at least `MIN_SYSTEM_JAVA_MAJOR`.
 */
export function requiredJavaMajor({ agpVersion, gradleVersion } = {}) {
	let required = MIN_SYSTEM_JAVA_MAJOR;
	const agpMajor = agpVersion ? Number(String(agpVersion).split(".")[0]) : NaN;
	if (!Number.isNaN(agpMajor) && agpMajor >= 8) required = 17;
	const gradleMajor = gradleVersion ? Number(String(gradleVersion).split(".")[0]) : NaN;
	if (!Number.isNaN(gradleMajor) && gradleMajor >= 8) required = Math.max(required, 17);
	return required;
}

/**
 * Best-effort AGP (Android Gradle Plugin) version detection: the classpath
 * coordinate in build scripts, an explicit plugins-DSL version, or the `agp`
 * version ref in `gradle/libs.versions.toml`.
 */
async function detectAgpVersion(projectDir) {
	const candidates = [
		"build.gradle",
		"build.gradle.kts",
		"settings.gradle",
		"settings.gradle.kts",
		join("buildSrc", "build.gradle"),
		join("buildSrc", "build.gradle.kts"),
		join("gradle", "libs.versions.toml")
	];
	for (const rel of candidates) {
		const text = await readFile(join(projectDir, rel), "utf8").catch(() => "");
		if (!text) continue;
		const m =
			/com\.android\.tools\.build:gradle:([0-9]+\.[0-9]+(?:\.[0-9]+)?)/.exec(text) ??
			/^\s*agp\s*=\s*"([0-9]+\.[0-9]+(?:\.[0-9]+)?)"/m.exec(text);
		if (m && m[1]) return m[1];
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

/** sdkmanager launcher name for the current platform. */
const SKM_BIN = process.platform === "win32" ? "sdkmanager.bat" : "sdkmanager";

/** Run sdkmanager with the given package args. */
async function runSdkmanager(sdkDir, args, { javaHome, signal, maxTail = 400_000 }) {
	const bin = join(sdkDir, "cmdline-tools", "latest", "bin", SKM_BIN);
	if (process.platform !== "win32") {
		try {
			chmodSync(bin, 0o755);
		} catch {
			// best effort — the archive usually ships executable bits anyway
		}
	}
	const env = {
		...process.env,
		JAVA_HOME: javaHome ?? process.env.JAVA_HOME ?? "",
		ANDROID_HOME: sdkDir,
		ANDROID_SDK_ROOT: sdkDir
	};
	// Spawn the launcher directly with argv (Windows uses cmd.exe to interpret
	// the .bat) rather than gluing a hand-quoted string through `cmd.exe /c`,
	// which is fragile for paths containing spaces or non-ASCII (CJK) chars.
	return runCommand(bin, args, { cwd: sdkDir, env, signal, maxTail });
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
	await mkdir(sdkDir, { recursive: true });
	const haveTools = existsSync(join(sdkDir, "cmdline-tools", "latest", "bin", SKM_BIN));
	if (haveTools) {
		log(`[sdk] reusing commandline-tools already present in ${sdkDir}`);
	} else {
		log(`[sdk] no usable Android SDK found — downloading commandline-tools into ${sdkDir}`);
		const stamp = `${process.pid}-${Date.now()}`;
		const zipPath = join(downloadDir, `cmdline-tools-${stamp}.zip`);
		const used = await tryMirrors(commandlineToolsUrls(), zipPath, {
			signal,
			onProgress: progressLogger("cmdline-tools", log)
		});
		log(`[sdk] commandline-tools downloaded from ${used}`);
		const tempExtract = join(downloadDir, `cmdline-tools-extract-${stamp}`);
		await mkdir(tempExtract, { recursive: true });
		await extractZip(zipPath, tempExtract);
		await rm(zipPath, { force: true }).catch(() => {});
		const latestDir = join(sdkDir, "cmdline-tools", "latest");
		await mkdir(dirname(latestDir), { recursive: true });
		const inner = join(tempExtract, "cmdline-tools");
		if (existsSync(join(inner, "bin", SKM_BIN))) {
			await rm(latestDir, { recursive: true, force: true }).catch(() => {});
			await renameSafe(inner, latestDir);
		} else if (existsSync(join(tempExtract, "bin", SKM_BIN))) {
			await renameSafe(tempExtract, latestDir);
		} else {
			throw new Error("commandline-tools archive did not contain sdkmanager");
		}
		await rm(tempExtract, { recursive: true, force: true }).catch(() => {});
	}
	await writeSdkLicenses(sdkDir);

	log("[sdk] querying available packages via sdkmanager --list …");
	// `--list` prints every available package (hundreds of KB); the tail buffer
	// must be large enough or the build-tools/platform rows get truncated away.
	const list = await runSdkmanager(sdkDir, ["--list"], { javaHome, signal, maxTail: 8_000_000 });
	if (list.code !== 0) {
		throw new Error(`sdkmanager --list failed: ${(list.stderr || list.stdout).slice(-2000)}`);
	}
	const { buildToolsVersion, platform } = pickSdkPackages(list.stdout + list.stderr, compileSdk);
	if (platform === null) {
		throw new Error(`sdkmanager --list offered no Android platform for compileSdk ${compileSdk} — pass an explicit compileSdk`);
	}
	if (platform !== compileSdk) {
		log(`[sdk] warning: platforms;android-${compileSdk} is not available — installing android-${platform} instead`);
	}
	const packages = ["platform-tools", `platforms;android-${platform}`];
	if (buildToolsVersion !== null) packages.push(`build-tools;${buildToolsVersion}`);
	log(`[sdk] installing ${packages.join(", ")} …`);
	const install = await runSdkmanager(sdkDir, packages, { javaHome, signal, maxTail: 800_000 });
	if (install.code !== 0) {
		throw new Error(`sdkmanager install failed (${install.stderr.slice(-2000) || install.stdout.slice(-2000)})`);
	}
	if (!existsSync(join(sdkDir, "platforms", `android-${platform}`))) {
		throw new Error(`sdkmanager reported success but platforms/android-${platform} is missing`);
	}
	// Without build-tools the SDK never counts as "usable" and the next run
	// would start the whole download over — fail loudly instead of looping.
	if (readdirSyncSafe(join(sdkDir, "build-tools")).length === 0) {
		throw new Error(
			`sdkmanager did not install any build-tools (parsed version: ${buildToolsVersion ?? "none"}) — ` +
				`the sdkmanager --list output could not be parsed or the download failed`
		);
	}
	log(`[sdk] ready at ${sdkDir} (platform android-${platform}, build-tools ${buildToolsVersion ?? "?"})`);
	return { sdkDir, source: "downloaded", platform };
}

/**
 * Make sure the project's `local.properties` records a usable `sdk.dir`.
 * AGP prefers `local.properties` over `ANDROID_HOME`, so a stale entry (e.g.
 * an SDK folder that was deleted) silently breaks the build even when the
 * environment points at a good SDK — rewrite it when it is wrong.
 */
async function ensureLocalPropertiesSdk(projectDir, sdkDir, { log, source }) {
	const current = await readSdkDirFromLocalProperties(projectDir);
	if (current === sdkDir) return;
	// Nothing stale to fix: leave an untouched project alone unless the SDK is
	// the one this plugin downloaded (then pin it, like a fresh `sdk.dir` write).
	if (current === null && source !== "downloaded") return;
	const encoded = sdkDir.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
	try {
		let existing = "";
		try {
			existing = await readFile(join(projectDir, "local.properties"), "utf8");
		} catch {
			// no file yet
		}
		const lines = existing ? existing.split(/\r?\n/) : [];
		const idx = lines.findIndex((l) => /^\s*sdk\.dir\s*=/.test(l));
		if (idx >= 0) {
			log(`[sdk] local.properties sdk.dir is stale (${current ?? "unset"}) — pointing it at ${sdkDir}`);
			lines[idx] = `sdk.dir=${encoded}`;
		} else {
			log(`[sdk] recording sdk.dir=${sdkDir} in local.properties`);
			lines.push(`sdk.dir=${encoded}`);
		}
		const body = lines.join("\n").replace(/\n+$/, "");
		await writeFile(join(projectDir, "local.properties"), body ? `${body}\n` : "");
	} catch (err) {
		log(`[sdk] could not update local.properties (${err.message}) — relying on ANDROID_HOME`);
	}
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

/**
 * Ensure a Gradle launcher. Returns `{ command, preArgs, source, gradleHome }`.
 * The project wrapper is preferred, but only when its Gradle version can
 * actually run on the JDK in use (a Gradle 7.0 wrapper dies on Java 17).
 */
async function ensureGradle(
	projectDir,
	downloadDir,
	det,
	{ gradleVersion, javaMajor, signal, log, forceDownload = false } = {}
) {
	const isWin = process.platform === "win32";
	const wrapperPath = join(projectDir, isWin ? "gradlew.bat" : "gradlew");
	const wrapperVersionRunnable = isGradleRunnableOn(det.wrapperVersion, javaMajor);
	if (!forceDownload && det.wrapperJar && det.hasWrapperScript) {
		if (wrapperVersionRunnable) {
			if (!isWin) {
				try {
					chmodSync(wrapperPath, 0o755);
					accessSync(wrapperPath, fsConstants.X_OK);
				} catch {
					log(`[gradle] wrapper ${wrapperPath} is not executable — running it through sh`);
					return { command: "sh", preArgs: [wrapperPath], source: "wrapper", gradleHome: null };
				}
			}
			log(`[gradle] using project wrapper ${wrapperPath}${det.wrapperVersion ? ` (Gradle ${det.wrapperVersion})` : ""}`);
			return { command: wrapperPath, source: "wrapper", gradleHome: null };
		}
		log(
			`[gradle] wrapper Gradle ${det.wrapperVersion} cannot run on Java ${javaMajor ?? "?"} ` +
				`— downloading Gradle ${gradleVersion} instead`
		);
	} else if (forceDownload) {
		log("[gradle] building from a staged ASCII copy — using a downloaded Gradle distribution instead of the wrapper");
	}
	const version =
		(det.wrapperVersion && wrapperVersionRunnable ? det.wrapperVersion : null) ??
		gradleVersion ??
		DEFAULT_GRADLE_VERSION;
	if (!det.wrapperJar || !det.hasWrapperScript) {
		log(`[gradle] no usable wrapper — downloading Gradle ${version} distribution`);
	}
	const gradleHome = join(downloadDir, "gradle", `gradle-${version}`);
	const gradleBin = join(gradleHome, "bin", isWin ? "gradle.bat" : "gradle");
	const complete = existsSync(gradleBin) && existsSync(join(gradleHome, "lib"));
	if (!complete) {
		const zipPath = join(downloadDir, `gradle-${process.pid}-${Date.now()}.zip`);
		const used = await tryMirrors(gradleDownloadUrls(version), zipPath, {
			signal,
			onProgress: progressLogger(`gradle ${version}`, log)
		});
		log(`[gradle] distribution downloaded from ${used}`);
		await extractZip(zipPath, dirname(gradleHome));
		await rm(zipPath, { force: true }).catch(() => {});
		if (!existsSync(gradleBin)) {
			throw new Error(`Gradle ${version} archive extracted but ${gradleBin} is missing`);
		}
	}
	if (!isWin) {
		try {
			chmodSync(gradleBin, 0o755);
		} catch {
			// best effort
		}
	}
	log(`[gradle] using downloaded Gradle at ${gradleBin}`);
	return { command: gradleBin, preArgs: [], source: "downloaded", gradleHome };
}

/**
 * Find produced APKs under the build/outputs/apk folder of any module.
 * `since` (epoch ms) drops stale APKs left over from earlier builds so the
 * tool never reports an artifact this run did not produce.
 */
async function findApks(projectDir, { since } = {}) {
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
					if (since && info.mtimeMs < since) continue;
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

/** Copy APKs into `apkOutputDir`; returns `[{ src, dest }]` for what succeeded. */
async function copyApks(apks, apkOutputDir, { log }) {
	await mkdir(apkOutputDir, { recursive: true });
	const copied = [];
	const seen = new Map();
	for (const apk of apks) {
		// two modules can produce the same file name — suffix collisions instead
		// of silently overwriting one with the other
		let dest = join(apkOutputDir, basename(apk.path));
		const n = seen.get(dest) ?? 0;
		seen.set(dest, n + 1);
		if (n > 0) dest = join(apkOutputDir, `${n + 1}-${basename(apk.path)}`);
		try {
			await copyFile(apk.path, dest);
			copied.push({ src: apk.path, dest });
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

/**
 * The SKU string that identifies a given SDK layout for staging cache reuse.
 * Keyed on the actual platform/build-tools folders so installing (or removing)
 * packages invalidates a stale staged copy.
 */
function sdkSku(sdkDir, platform) {
	const platforms = readdirSyncSafe(join(sdkDir, "platforms")).sort().join(",");
	const buildTools = readdirSyncSafe(join(sdkDir, "build-tools")).sort().join(",");
	return `platform;${platform}|platforms:${platforms}|build-tools:${buildTools}`;
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
			if (readFileSyncSafe(marker).trim() === sku) {
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

/** Build outputs / VCS / IDE folders that never need staging into the temp dir. */
const STAGE_SKIP = new Set(["build", ".gradle", ".idea", ".git", "node_modules", ".cxx", "captures"]);

/** `fs.cp` filter that drops build caches and stale outputs from the staged copy. */
function stageCopyFilter(projectDir) {
	return (src) => {
		if (src === projectDir) return true;
		if (basename(src) === "local.properties") return false; // rewritten below
		return !relative(projectDir, src).split(sep).some((seg) => STAGE_SKIP.has(seg));
	};
}

/**
 * Stage the project under `asciiRoot/<project>-<hash>`; returns dst path.
 * The directory name is derived from the project (ASCII-sanitised) + a hash of
 * its real path so two different projects — or two concurrent builds — never
 * share a staging folder. Also writes a local.properties pointing at the
 * staged SDK.
 */
async function stageProject(asciiRoot, projectDir, stagedSdk) {
	const slug = basename(resolve(projectDir)).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "project";
	const hash = createHash("sha1").update(resolve(projectDir)).digest("hex").slice(0, 8);
	const dst = join(asciiRoot, `${slug}-${hash}`);
	await rm(dst, { recursive: true, force: true }).catch(() => {});
	await cp(projectDir, dst, { recursive: true, force: true, filter: stageCopyFilter(projectDir) });
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
		const argCompileSdk = Number(args.compileSdk) > 0 ? Number(args.compileSdk) : null;
		const compileSdk = argCompileSdk ?? (config.compileSdk && config.compileSdk > 0 ? config.compileSdk : null) ?? (await detectCompileSdk(project)) ?? DEFAULT_COMPILE_SDK;
		log(`[project] ${project}`);
		log(`[project] compileSdk = ${compileSdk}`);

		// AGP 8 needs Java 17, AGP 7 needs 11 — a system Java 11 is not enough
		// for a modern project, so ask for the version the toolchain really uses.
		const agpVersion = await detectAgpVersion(project);
		const effectiveGradle = det.wrapperVersion ?? gradleVersion;
		const requiredJava = requiredJavaMajor({ agpVersion, gradleVersion: effectiveGradle });
		if (agpVersion) log(`[project] detected AGP ${agpVersion}`);
		log(`[jdk] toolchain requires Java ${requiredJava}+`);

		const jdk = await ensureJdk(downloadDir, { jdkMajor, required: requiredJava, signal, log });
		outcome.jdk = `${jdk.source}:${jdk.home ?? "PATH"}`;

		const sdk = await ensureAndroidSdk(project, downloadDir, { compileSdk, javaHome: jdk.home, signal, log });
		outcome.sdk = `${sdk.source}:${sdk.sdkDir}`;
		// AGP prefers local.properties over ANDROID_HOME — repair a stale entry.
		await ensureLocalPropertiesSdk(project, sdk.sdkDir, { log, source: sdk.source });
		if (signal?.aborted) throw new Error("build aborted by caller");

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
			javaMajor: jdk.major,
			signal,
			log,
			// under staging the build runs from an ASCII copy; use a downloaded
			// distribution (never the wrapper jar, whose version may be stale)
			// for reliability.
			forceDownload: buildCtx.usedStaging
		});
		outcome.gradle = gradle.source === "wrapper" ? `wrapper:${gradle.command}` : `downloaded:${gradle.command}`;

		// Keep the caller's casing: `assembleStagingDebug` must not become
		// `assembleStagingdebug` (only the first letter is capitalised).
		const variant = String(args.variant ?? config.defaultVariant ?? "debug").trim();
		if (!/^[a-zA-Z0-9]+$/.test(variant)) throw new Error(`invalid variant: ${variant}`);
		const task = `assemble${variant[0].toUpperCase()}${variant.slice(1)}`;
		// `clean` is a Gradle *task*, not a command-line flag — run it in the
		// same invocation ahead of the assemble task (Gradle executes tasks in
		// the declared order).
		const gradleArgs = [
			...(gradle.preArgs ?? []),
			...(args.clean === true ? ["clean"] : []),
			task,
			"--no-daemon",
			"--console=plain"
		];

		const env = { ...process.env };
		if (jdk.home) env.JAVA_HOME = jdk.home;
		env.ANDROID_HOME = buildSdk;
		env.ANDROID_SDK_ROOT = buildSdk;
		env.GRADLE_USER_HOME = join(downloadDir, "gradle-user-home");
		const pathBits = [];
		if (jdk.home) pathBits.push(join(jdk.home, "bin"));
		pathBits.push(join(buildSdk, "platform-tools"));
		env.PATH = `${pathBits.join(delimiter)}${delimiter}${process.env.PATH ?? ""}`;

		log(`[build] running: ${gradle.command} ${gradleArgs.join(" ")} (cwd ${buildProject})`);
		const gradleStartedAt = Date.now();
		const result = await runCommand(gradle.command, gradleArgs, { cwd: buildProject, env, signal });
		const combined = `${result.stdout}\n${result.stderr}`.trim();
		log(`[build] gradle exit code: ${result.code}${result.aborted ? " (aborted)" : ""}`);
		if (result.aborted) {
			throw new Error("build aborted by caller");
		}
		if (result.code !== 0) {
			throw new Error(`gradle build failed with exit code ${result.code}:\n${combined.slice(-4000)}`);
		}
		// Prefer APKs produced by this run; fall back to any APK on disk when
		// the timestamp filter comes back empty (clock skew, restored files).
		let apks = await findApks(buildProject, { since: gradleStartedAt - 60_000 });
		if (apks.length === 0) {
			log("[apk] no freshly-built APK matched the timestamp filter — collecting every APK under build/outputs/apk");
			apks = await findApks(buildProject);
		}
		if (apks.length === 0) {
			throw new Error(`build succeeded but no APK found under ${buildProject}\\**\\build\\outputs\\apk`);
		}
		const copied = await copyApks(apks, apkOutputDir, { log });
		const copiedBySrc = new Map(copied.map((c) => [c.src, c.dest]));
		outcome.apks = apks.map((apk) => ({
			path: apk.path,
			bytes: apk.bytes,
			copiedTo: copiedBySrc.get(apk.path),
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
