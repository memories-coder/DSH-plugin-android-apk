// dsh-plugin-android-apk — download helpers.
// Uses only Node built-ins so the bundle plugin runs anywhere the host runs.
// Node's own OpenSSL stack is used for TLS, which also keeps downloads
// working on hosts where the Windows schannel credential store is
// unavailable to sandboxed shells.
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

/** Adoptium OS / arch segments used in API + mirror URLs. */
const ADOPTIUM_OS = { win32: "windows", linux: "linux", darwin: "mac" };
const ADOPTIUM_ARCH = {
	x64: "x64",
	arm64: "aarch64",
	arm: "arm",
	ppc64le: "ppc64le",
	s390x: "s390x",
	riscv64: "riscv64"
};

/** Current platform's Adoptium triple + archive extension. */
function jdkTarget() {
	const os = ADOPTIUM_OS[process.platform] ?? "linux";
	const arch = ADOPTIUM_ARCH[process.arch] ?? process.arch;
	return { os, arch, ext: process.platform === "win32" ? "zip" : "tar.gz" };
}

/**
 * Download `url` to `dest` (streaming), observing `signal` for abort and
 * reporting progress via `onProgress(received, total)`.
 *
 * Fails when the connection drops early (received < content-length), when the
 * destination stream errors (disk full, permissions), and when the body
 * aborts — a truncated file is always removed so the next mirror starts clean.
 */
export async function downloadFile(url, dest, { signal, onProgress } = {}) {
	await mkdir(dirname(dest), { recursive: true });
	const res = await fetch(url, { signal, redirect: "follow" });
	if (!res.ok || !res.body) {
		throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
	}
	const total = Number(res.headers.get("content-length") || 0);
	// with a compressed body the header counts the wire bytes, not what we read
	const compressed = Boolean(res.headers.get("content-encoding")) && res.headers.get("content-encoding") !== "identity";
	const reader = res.body.getReader();
	const ws = createWriteStream(dest);
	let received = 0;
	let streamError = null;
	const fail = (err) => {
		streamError = streamError ?? err;
	};
	ws.on("error", fail);
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (streamError) throw streamError;
			received += value.byteLength;
			if (typeof onProgress === "function") onProgress(received, total);
			if (!ws.write(Buffer.from(value))) {
				await new Promise((resolveWrite) => {
					ws.once("drain", resolveWrite);
					ws.once("error", resolveWrite);
				});
			}
		}
		if (streamError) throw streamError;
		if (total > 0 && !compressed && received !== total) {
			throw new Error(`incomplete download: got ${received} of ${total} bytes — ${url}`);
		}
		await new Promise((resolveWrite, rejectWrite) => {
			ws.once("error", rejectWrite);
			ws.end(() => resolveWrite());
		});
	} catch (err) {
		ws.destroy();
		try {
			await reader.cancel();
		} catch {
			// body already gone
		}
		await rm(dest, { force: true }).catch(() => {});
		throw err;
	}
}

/** Run one extractor command; record a short reason when it fails. */
function tryExtract(attempts, label, cmd, argv) {
	let r;
	try {
		r = spawnSync(cmd, argv, { stdio: "pipe" });
	} catch (err) {
		attempts.push(`${label}: ${err.message}`);
		return false;
	}
	if (r.status === 0) return true;
	attempts.push(`${label}: ${String(r.error?.message ?? r.stderr ?? "").slice(-400)}`);
	return false;
}

/** Escape a value for use inside a PowerShell single-quoted literal. */
function psQuote(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Extract a `.zip` (or `.tar.gz`) archive into `destDir`.
 * Windows: bundled bsdtar first (fast, unicode-safe), then Expand-Archive.
 * POSIX: unzip, then `python3 -m zipfile`, then tar.
 */
export async function extractZip(zipPath, destDir) {
	await mkdir(destDir, { recursive: true });
	const attempts = [];
	if (process.platform === "win32") {
		if (tryExtract(attempts, "tar", "tar", ["-xf", zipPath, "-C", destDir])) return;
		const script =
			`try { Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force }` +
			` catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
		if (tryExtract(attempts, "powershell", "powershell", ["-NoProfile", "-Command", script])) return;
	} else {
		if (tryExtract(attempts, "unzip", "unzip", ["-q", "-o", zipPath, "-d", destDir])) return;
		if (tryExtract(attempts, "python3", "python3", ["-m", "zipfile", "-e", zipPath, destDir])) return;
		if (tryExtract(attempts, "tar", "tar", ["-xf", zipPath, "-C", destDir])) return;
	}
	throw new Error(`failed to extract ${zipPath}: ${attempts.join(" | ") || "no extractor available"}`);
}

/**
 * Try each URL in order until one downloads successfully. Returns the URL used.
 * An aborted signal stops the loop immediately instead of burning through the
 * remaining mirrors with a dead socket.
 */
export async function tryMirrors(urls, dest, opts) {
	let lastErr;
	for (const url of urls) {
		try {
			await downloadFile(url, dest, opts);
			return url;
		} catch (err) {
			lastErr = err;
			if (opts?.signal?.aborted) throw err;
		}
	}
	throw new Error(`all download mirrors failed: ${lastErr?.message ?? "unknown error"}`);
}

/**
 * Candidate JDK (Temurin) download URLs for `jdkMajor` on the current
 * platform/arch: the Adoptium API first, then the Tsinghua mirror directory
 * listing (resolved to its newest archive).
 */
export async function jdkDownloadUrls(jdkMajor) {
	const { os, arch, ext } = jdkTarget();
	const urls = [
		`https://api.adoptium.net/v3/binary/latest/${jdkMajor}/ga/${os}/${arch}/jdk/hotspot/normal/eclipse?project=jdk`
	];
	try {
		const res = await fetch(`https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${jdkMajor}/jdk/${arch}/${os}/`, {
			signal: AbortSignal.timeout(15000)
		});
		if (res.ok) {
			const html = await res.text();
			const pattern = `href="(OpenJDK\\d+U-jdk_${arch}_${os}_hotspot_[\\d._]+\\.${ext.replace(/\./g, "\\.")})"`;
			const re = new RegExp(pattern, "g");
			let match;
			let latest = null;
			while ((match = re.exec(html)) !== null) latest = match[1];
			if (latest) {
				urls.push(`https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${jdkMajor}/jdk/${arch}/${os}/${latest}`);
			}
		}
	} catch {
		// mirror listing unavailable — keep the primary URL only
	}
	return urls;
}

/** Candidate Gradle distribution URLs (official + CN mirrors). */
export function gradleDownloadUrls(version) {
	const base = `gradle-${version}-bin.zip`;
	return [
		`https://services.gradle.org/distributions/${base}`,
		`https://mirrors.cloud.tencent.com/gradle/${base}`,
		`https://mirrors.aliyun.com/macports/distfiles/gradle/${base}`
	];
}

/** Candidate Android commandline-tools URLs for the current platform. */
export function commandlineToolsUrls() {
	const os = process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : "win";
	const name = `commandlinetools-${os}-11076708_latest.zip`;
	return [
		`https://dl.google.com/android/repository/${name}`,
		`https://mirrors.cloud.tencent.com/AndroidSDK/${name}`
	];
}
