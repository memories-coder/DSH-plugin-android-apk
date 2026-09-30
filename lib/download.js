// dsh-plugin-android-apk — download helpers.
// Uses only Node built-ins so the bundle plugin runs anywhere the host runs.
// Node's own OpenSSL stack is used for TLS, which also keeps downloads
// working on hosts where the Windows schannel credential store is
// unavailable to sandboxed shells.
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

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
 * destination stream errors (disk full, permissions), when the body aborts,
 * and when `expect` is given and the SHA-256/SHA-1 digest does not match — a
 * bad or truncated file is always removed so the next mirror starts clean.
 */
export async function downloadFile(url, dest, { signal, onProgress, expect } = {}) {
	await mkdir(dirname(dest), { recursive: true });
	const res = await fetch(url, { signal, redirect: "follow" });
	if (!res.ok || !res.body) {
		throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
	}
	const total = Number(res.headers.get("content-length") || 0);
	// with a compressed body the header counts the wire bytes, not what we read
	const compressed = Boolean(res.headers.get("content-encoding")) && res.headers.get("content-encoding") !== "identity";
	let hash = null;
	if (expect?.value) {
		try {
			hash = createHash(expect.algo || "sha256");
		} catch {
			hash = null; // unknown algorithm — skip verification rather than fail
		}
	}
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
			if (hash) hash.update(value);
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
		if (hash) {
			const expected = String(expect.value).toLowerCase();
			const actual = hash.digest("hex");
			if (actual !== expected) {
				throw new Error(
					`checksum mismatch (${expect.algo || "sha256"}) for ${url}: expected ${expected}, got ${actual}`
				);
			}
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

/** Short bounded GET returning plain text, or null on any failure. */
async function fetchText(url, signal) {
	const timeout = AbortSignal.timeout(15000);
	let combined = timeout;
	try {
		combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	} catch {
		combined = timeout;
	}
	try {
		const res = await fetch(url, { signal: combined });
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	}
}

/** Pull the first fixed-width hex digest out of a checksum file/text. */
function parseHexHash(text, algo) {
	const len = algo === "sha1" ? 40 : 64;
	const m = new RegExp(`\\b[0-9a-fA-F]{${len}}\\b`).exec(String(text ?? ""));
	return m ? m[0].toLowerCase() : null;
}

/**
 * Best-effort official checksum lookup for a download URL.
 * Returns `{ algo, value, from }` or null — never throws, so a missing or
 * unreachable checksum source simply means "download without verification"
 * instead of blocking the build.
 *
 * - Gradle: `<distribution>.sha256` published next to the zip
 * - Tsinghua Adoptium mirror: `<archive>.sha256.txt` next to the archive
 * - Android SDK: the `sha1`/`sha256` recorded in Google's repository XML
 */
export async function resolveExpectedChecksum(url, signal) {
	try {
		if (/\.zip$/.test(url) && /gradle/i.test(url)) {
			const text = await fetchText(`${url}.sha256`, signal);
			const value = parseHexHash(text, "sha256");
			return value ? { algo: "sha256", value, from: `${url}.sha256` } : null;
		}
		if (/mirrors\.tuna\.tsinghua\.edu\.cn\/Adoptium\//.test(url)) {
			const text = await fetchText(`${url}.sha256.txt`, signal);
			const value = parseHexHash(text, "sha256");
			return value ? { algo: "sha256", value, from: `${url}.sha256.txt` } : null;
		}
		if (/\/android\/repository\/|\/AndroidSDK\//.test(url)) {
			const name = url.split("?")[0].split("/").pop();
			if (!name) return null;
			for (const xml of ["repository2-3.xml", "repository2-2.xml", "repository2-1.xml"]) {
				const text = await fetchText(`https://dl.google.com/android/repository/${xml}`, signal);
				if (!text) continue;
				const idx = text.indexOf(`<url>${name}</url>`);
				if (idx < 0) continue;
				// checksum lives inside the same <complete> block as the <url>
				const start = text.lastIndexOf("<complete>", idx);
				const end = text.indexOf("</complete>", idx);
				if (start < 0 || end < 0 || end < start) return null;
				const m = /<checksum type="(sha1|sha256)">([0-9a-fA-F]+)<\/checksum>/.exec(text.slice(start, end));
				if (m) return { algo: m[1], value: m[2].toLowerCase(), from: `dl.google.com/${xml}` };
				return null;
			}
			return null;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Try each URL in order until one downloads successfully. Returns the URL used.
 * A spec may be a plain string or `{ url, expect }`; when no expected checksum
 * is attached, `resolveExpectedChecksum` (unless overridden) is consulted so
 * each mirror download is verified against the upstream digest when available.
 * An aborted signal stops the loop immediately instead of burning through the
 * remaining mirrors with a dead socket.
 */
export async function tryMirrors(specs, dest, opts = {}) {
	const resolver = opts.resolveChecksum === false ? null : opts.resolveChecksum ?? resolveExpectedChecksum;
	let lastErr;
	for (const spec of specs ?? []) {
		const { url, expect: provided } = typeof spec === "string" ? { url: spec, expect: null } : spec;
		let expect = provided ?? null;
		if (!expect && resolver) {
			try {
				expect = await resolver(url, opts.signal);
			} catch {
				expect = null;
			}
		}
		try {
			await downloadFile(url, dest, { ...opts, expect });
			if (expect && typeof opts.onVerified === "function") opts.onVerified(url, expect);
			return url;
		} catch (err) {
			lastErr = err;
			if (opts?.signal?.aborted) throw err;
		}
	}
	throw new Error(`all download mirrors failed: ${lastErr?.message ?? "unknown error"}`);
}

/**
 * Resolve the current Adoptium GA release through the assets API, which also
 * publishes the archive's SHA-256 — returns a `{ url, expect }` spec, or a
 * plain URL when no checksum is offered, or null on failure.
 */
async function adoptiumAssetSpec(jdkMajor) {
	const { os, arch } = jdkTarget();
	const api =
		`https://api.adoptium.net/v3/assets/latest/${jdkMajor}/hotspot` +
		`?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`;
	const text = await fetchText(api);
	if (!text) return null;
	const pkg = JSON.parse(text)?.[0]?.binary?.package;
	if (!pkg?.link) return null;
	if (!pkg.checksum) return pkg.link;
	return { url: pkg.link, expect: { algo: "sha256", value: String(pkg.checksum).toLowerCase(), from: "Adoptium assets API" } };
}

/**
 * Candidate JDK (Temurin) download URLs for `jdkMajor` on the current
 * platform/arch: the Adoptium assets API entry (with its official SHA-256)
 * first, then the plain binary endpoint, then the Tsinghua mirror directory
 * listing (resolved to its newest archive).
 */
export async function jdkDownloadUrls(jdkMajor) {
	const { os, arch, ext } = jdkTarget();
	const urls = [];
	try {
		const asset = await adoptiumAssetSpec(jdkMajor);
		if (asset) urls.push(asset);
	} catch {
		// assets API unavailable — fall through to the plain endpoint
	}
	urls.push(`https://api.adoptium.net/v3/binary/latest/${jdkMajor}/ga/${os}/${arch}/jdk/hotspot/normal/eclipse?project=jdk`);
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
