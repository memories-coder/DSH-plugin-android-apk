// dsh-plugin-android-apk — download helpers.
// Uses only Node built-ins so the bundle plugin runs anywhere the host runs.
// Node's own OpenSSL stack is used for TLS, which also keeps downloads
// working on hosts where the Windows schannel credential store is
// unavailable to sandboxed shells.
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Download `url` to `dest` (streaming), observing `signal` for abort and
 * reporting progress via `onProgress(received, total)`.
 */
export async function downloadFile(url, dest, { signal, onProgress } = {}) {
	await mkdir(dirname(dest), { recursive: true });
	const res = await fetch(url, { signal, redirect: "follow" });
	if (!res.ok || !res.body) {
		throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
	}
	const total = Number(res.headers.get("content-length") || 0);
	const reader = res.body.getReader();
	const ws = createWriteStream(dest);
	let received = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (typeof onProgress === "function") onProgress(received, total);
			if (!ws.write(Buffer.from(value))) {
				await new Promise((resolveWrite) => ws.once("drain", resolveWrite));
			}
		}
		await new Promise((resolveWrite, rejectWrite) => ws.end(resolveWrite));
	} catch (err) {
		ws.destroy();
		await rm(dest, { force: true }).catch(() => {});
		throw err;
	}
}

/**
 * Extract a .zip archive into `destDir`. Prefers Windows' bundled bsdtar
 * (fast, unicode-safe), falling back to PowerShell Expand-Archive.
 */
export async function extractZip(zipPath, destDir) {
	await mkdir(destDir, { recursive: true });
	if (process.platform === "win32") {
		const tar = spawnSync("tar", ["-xf", zipPath, "-C", destDir], { stdio: "pipe" });
		if (tar.status === 0) return;
	}
	const ps = spawnSync(
		"powershell",
		["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
		{ stdio: "pipe" }
	);
	if (ps.status !== 0) {
		throw new Error(
			`failed to extract ${zipPath}: tar: ${String(tar?.stderr ?? "")} ps: ${String(ps.stderr ?? "")}`
		);
	}
}

/** Try each URL in order until one downloads successfully. Returns the URL used. */
export async function tryMirrors(urls, dest, opts) {
	let lastErr;
	for (const url of urls) {
		try {
			await downloadFile(url, dest, opts);
			return url;
		} catch (err) {
			lastErr = err;
		}
	}
	throw new Error(`all download mirrors failed: ${lastErr?.message ?? "unknown error"}`);
}

/**
 * Candidate JDK (Temurin) download URLs for `jdkMajor` on Windows x64:
 * the Adoptium API first, then the Tsinghua mirror directory listing.
 */
export async function jdkDownloadUrls(jdkMajor) {
	const urls = [
		`https://api.adoptium.net/v3/binary/latest/${jdkMajor}/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk`
	];
	try {
		const res = await fetch(`https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${jdkMajor}/jdk/x64/windows/`, {
			signal: AbortSignal.timeout(15000)
		});
		if (res.ok) {
			const html = await res.text();
			const re = /href="(OpenJDK\d+U-jdk_x64_windows_hotspot_[\d._]+\.zip)"/g;
			let match;
			let latest = null;
			while ((match = re.exec(html)) !== null) latest = match[1];
			if (latest) {
				urls.push(`https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${jdkMajor}/jdk/x64/windows/${latest}`);
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

/** Candidate Android commandline-tools URLs. */
export function commandlineToolsUrls() {
	const name = "commandlinetools-win-11076708_latest.zip";
	return [
		`https://dl.google.com/android/repository/${name}`,
		`https://mirrors.cloud.tencent.com/AndroidSDK/${name}`
	];
}
