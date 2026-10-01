# Changelog

All notable changes to `dsh-plugin-android-apk` are documented in this file.

> 简体中文版：[`CHANGELOG.zh-CN.md`](CHANGELOG.zh-CN.md)

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release ledger (tarball names + SHA-256): [`RELEASES.txt`](RELEASES.txt).

> **Maintenance rule: every change bumps the version and lands a section here
> before the tarball is packed, and no released tarball is ever deleted. The
> English and Chinese versions of this file are updated together.**

## [0.2.4] - 2026-10-01

### Changed

- **The toolchain now downloads into the plugin's own package directory
  (`<plugin>/toolchain`) instead of `<workspace>/.android-build`.** One shared
  toolchain now serves every session and every project, instead of each
  workspace growing its own copy of a ~460MB JDK + SDK + Gradle download (plus a
  `gradle-user-home` dependency cache). The location is derived from the module
  URL, so it is correct wherever the profile installed the package — including
  inside `node_modules` — and an explicit `downloadDir` argument or
  `downloadRoot` config still wins, with relative values still resolving against
  the session workspace.
  If the plugin directory is not writable (a read-only install), the plugin logs
  that and falls back to `<workspace>/.android-build` instead of failing.
  ⚠ Because the folder lives inside the package, upgrading the plugin rebuilds
  the directory and the cached toolchain is lost; point `downloadRoot` at a fixed
  path to keep it across upgrades.
- `apkOutputDir` default is unchanged — built APKs still land in
  `<workspace>/apk`, where the caller can find them.
- Tool description, parameter description, config comment, the package
  `description` field and the README were updated for the new default location.

## [0.2.3] - 2026-10-01

### Fixed

- **Platforms whose requested JDK has no upstream build could not get a JDK.**
  Temurin publishes **no `windows/aarch64` JDK 17** (verified against the
  Adoptium assets API: `builds=0` for 17, `builds=1` for 21), so on a Windows-ARM
  host with no system Java every JDK candidate 404'd and the build failed with
  "all download mirrors failed". The plugin now resolves the feature release
  through the assets API and walks a small LTS ladder (17 → 21 → 25) when the
  requested release has no build for this platform/arch, logging the fallback:

  ```
  [jdk] Temurin 17 has no win32/arm64 build — falling back to Temurin 21
  [jdk] downloading Temurin JDK 21 (win32/arm64) …
  ```

  The resolved release pins **every** candidate URL (assets API entry, plain
  endpoint, Tsinghua mirror listing), so a mirror fallback can never silently
  fetch a different version than the one whose checksum was verified. The
  ladder is only walked when the API is reachable and answers "no build" — if
  the API itself is down, the requested release is kept and the plain-endpoint /
  mirror candidates still apply.
- **32-bit x86 resolved to a non-existent Adoptium arch.** `process.arch` reports
  `ia32` while Adoptium names that architecture `x86`, so the JDK URL 404'd.
  Added the `ia32 → x86` mapping.

### Verified

- Live Adoptium resolution for requested JDK 17: `win32/x64`, `linux/x64`,
  `linux/arm64`, `darwin/x64`, `darwin/arm64` → **17 as requested**;
  `win32/arm64` → **21 (fallback)**. Every resolved artifact and all three
  `commandlinetools-{win,linux,mac}` archives answered successfully.
- Windows x64 build still passes end-to-end (see 0.2.2).

## [0.2.2] - 2026-10-01

Found by the first real end-to-end build (a from-scratch toolchain provision of
~1.1GB: Temurin JDK 17 + Android SDK 34 + Gradle 8.9).

### Fixed

- **Download progress flooded the build log.** `progressLogger` had a "print the
  closing line" bypass (`received >= total`) that stayed true for *every*
  remaining chunk. A mirror serving a compressed response advertises the
  compressed `Content-Length` while the reporter counts decoded bytes, so
  `received` ran past `total` early: one 127MB download behind a gzip'd 146MB
  body produced **~5,100 log lines** and pushed useful output out of the 300KB
  log tail. The reporter now emits one line per 32MB plus exactly one closing
  line, signalled by `downloadFile` through a new `final` callback argument.
- **`downloadFile` leaked write-stream `error` listeners.** The backpressure
  wait registered `ws.once("error", resolveWrite)`; when `drain` fired normally
  that listener was never removed, so a large download accumulated thousands of
  them and tripped Node's `MaxListenersExceededWarning` (observed at 11+). Both
  listeners are now removed when the wait ends.

### Added

- `RELEASES.txt` — release ledger and the maintenance rules for this package.

### Changed

- `README.md` install section now uses `--profile <profile>` instead of a
  hard-coded `web`, with notes on finding the active profile and on installing
  once per profile (the plugin is a profile-level dependency).
- `progressLogger` is now exported.

## [0.2.1] - 2026-10-01

### Fixed

- **DSH failed to start after installing the plugin** (`DesktopHostFatalError:
  dsh: startup failed: 1 required plugin did not activate`, `tools` → *failed to
  import*, 7 plugins waiting on `tools`; the failed-startup recovery could also
  reset the user's `cordis.patch.yml` / `dsh.profile.bundles`).
  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`
  were declared as `dependencies`, so pnpm installed a copy into the profile.
  That copy of `dsh-tools` fails to import on its own (`autoInstallPeers: false`
  leaves its eight `@deepseek-ai/dsh-*` peers unmet), is older than the host's
  copy, and — resolving ahead of the install — shadows the host's `tools`
  service. DSH provides these packages via host-install + resolution
  interception and expects plugins to declare them as peers. All three moved to
  `peerDependencies`, with `@deepseek-ai/dsh-tools` widened to
  `>=0.1.0-rc.6 <2` so host evolution is not judged incompatible.
  Plugin code unchanged.
  → fixed in [issue #2](https://github.com/memories-coder/DSH-plugin-android-apk/issues/2).
- **Tool registration failed with `userRender is not a function`**, and a
  successful build's output was rejected by the host schema/render check. The
  host's `harness.defineTool` requires `output` to be `{ schema, render }`, but
  only `schema` was declared. Added
  `render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]`
  — the signature and content-block return shape used by every other plugin in
  the profile.
  Part of [PR #1](https://github.com/memories-coder/DSH-plugin-android-apk/pull/1).
- **Linux / Termux build path** (from the community PR): platform-aware Java /
  Gradle / sdkmanager launchers, Adoptium OS/arch URL triple, `unzip → python3
  -m zipfile → tar` extraction, and `taskkill` / `cmd.exe` / `powershell`
  guards, so the builder works outside Windows. Verified end-to-end on Termux
  (aarch64, Android 15).
  → [PR #1](https://github.com/memories-coder/DSH-plugin-android-apk/pull/1).
- **`findApks` ignored the variant.** Every APK under `build/outputs/apk` was
  reported as this run's output, including other variants' leftovers. It now
  filters on the requested variant's name token (`-debug.apk`, `app-free-debug.apk`
  match `debug`; `app-release.apk` does not).
- **Concurrent builds could wipe each other's staging directory.** The staged
  SDK is a shared directory that is erased and re-copied; two builds targeting
  the same ASCII root could do that simultaneously. Staging is now serialised by
  a cross-process lock (exclusive-create lock file holding the holder pid), which
  is stolen when the holder is confirmed dead or the lock is older than 5
  minutes, so a crashed build cannot wedge later runs.
- **The response reader was never released on the success path.** Only the error
  path cancelled it, leaving the stream handle alive after a finished download.
- **An incomplete staged SDK could be cached as complete.** `copyPathIfPresent`
  silently skips a missing source, so the cache marker could be written for a
  staged SDK missing `platforms` / `build-tools` / `platform-tools`, and every
  later run would reuse it. The marker is now written only after those three are
  verified non-empty.

### Security

- **Downloaded toolchain artifacts are checksum-verified when upstream publishes
  a digest**, instead of trusting HTTPS and the mirror alone. A mismatch deletes
  the file and falls through to the next mirror:
  - JDK: Adoptium assets API `checksum` (SHA-256) as the primary candidate, plus
    `<archive>.sha256.txt` on the Tsinghua mirror;
  - Gradle: `<distribution>.sha256` published next to the zip;
  - Android cmdline-tools: the `<checksum>` entry for the archive in Google's
    `repository2-*.xml`.
  Checksum sources resolve best-effort (bounded, abortable requests); when one is
  unavailable the download proceeds unverified rather than blocking the build.
  Verified downloads log `[dl] … checksum verified …`. All three verifications
  were confirmed by the 0.2.2 end-to-end run.

### Added

- README FAQ entries for the `userRender` failure and the `peerDependencies`
  requirement, with recovery steps for a profile that already contains the
  shadowing `node_modules/@deepseek-ai/dsh-tools`.

## [0.2.0]

### Fixed

- **System Java was never detected.** `findSystemJava()` called `runCommand()`
  without `await`, so it inspected a `Promise` instead of the command output and
  always reported "no usable Java". Every run re-downloaded the Temurin JDK
  (~180MB) and ignored `JAVA_HOME`.
- **`readFileSync` was never imported.** The staged-SDK cache key silently fell
  back to an empty string on every call.
- **`clean: true` passed `--clean` to Gradle**, which is not a valid Gradle
  command-line option and failed the build immediately. It now runs the `clean`
  task in the same invocation, ahead of the assemble task.
- **Variant names were lower-cased**, so `stagingDebug` produced
  `assembleStagingdebug`. Casing is now preserved (`assembleStagingDebug`).
- **`apks[].copiedTo` could point at the wrong file** when a copy failed,
  because the copied array was zipped by index. Copies are now mapped by source
  path, and two modules producing the same file name no longer overwrite each
  other.
- **`extractZip` referenced `tar` outside its block**, throwing
  `ReferenceError` on the POSIX error path, and its only fallback was PowerShell
  (absent on POSIX). The chain is now `tar` → `Expand-Archive` on Windows and
  `unzip` → `python3 -m zipfile` → `tar` elsewhere.
- **Downloads could hang or silently corrupt.** The write stream's `error` event
  was not listened to (a disk-full error never settled the promise), truncated
  bodies were accepted as complete, and a failed mirror left a partial file
  behind.
- **`sdkmanager --list` output was truncated** by the 400KB log tail buffer, so
  the build-tools/platform rows were often missing and only `platform-tools` got
  installed. The buffer is now sized for that call, and the installed layout is
  verified afterwards.
- **`local.properties` could pin a dead `sdk.dir`.** It was written with
  `flag: "wx"`, so an entry pointing at a deleted SDK was never corrected — and
  AGP prefers `local.properties` over `ANDROID_HOME`. Stale entries are now
  detected and rewritten.
- **Windows-specific assumptions** (`java.exe`, `sdkmanager.bat`,
  `commandlinetools-win-*`, `taskkill`) made the documented POSIX support
  impossible. All are now platform-aware, including the Temurin OS/arch URL
  triple and archive extension.
- **`output.schema` omitted the `staged` field** while declaring
  `additionalProperties: false`.
- **`spawn()` synchronous failures were unhandled**, and `where java` /
  `which java` returning nothing crashed `findSystemJava()`.
- **`compileSdk: 0` was passed through** instead of falling back to
  auto-detection.

### Changed

- The required JDK is now **derived from the project** (AGP 8 / Gradle 8 →
  Java 17, otherwise 11) instead of assuming "any Java ≥ 11 works". The system
  JDK is used when it satisfies that requirement; otherwise the downloaded
  version is raised to match.
- A project **wrapper whose Gradle version cannot run on the selected JDK**
  (e.g. Gradle 7.0 on Java 17) is skipped in favour of a downloaded distribution.
- `apks[]` only contains APKs produced by the **current run** (mtime filter,
  with a logged fallback when nothing matches).
- `README.md` and the packaged tarball name moved to `0.2.0`.

### Improved

- **No repeated downloads:** a previously downloaded JDK is reused (keyed by the
  required Java version), and existing `cmdline-tools` are reused instead of
  re-fetching ~150MB. Temporary archives are named with `pid + timestamp` so
  concurrent calls cannot collide.
- **ASCII staging** folders are `<project>-<hash>` instead of a fixed
  `sample-app`, and the staged copy skips `build/`, `.gradle/`, `.git/`,
  `.idea/`, `.cxx/` — faster copies, no stale APKs dragged into the build tree.
- **Staged-SDK cache invalidation** is keyed on the real `platforms/` and
  `build-tools/` listings instead of a constant.
- **Download progress** is logged every ~32MB; an aborted signal stops the
  mirror loop immediately instead of retrying over a dead socket.
- **Failure messages are actionable:** missing platform/build-tools after
  install, an unparsable `sdkmanager --list`, or a Gradle distribution that
  extracted without its launcher now fail loudly instead of silently looping
  into another full download.
- Minor hardening: `path.delimiter` instead of a hand-written separator,
  guarded `spawn()` errors, logged `local.properties` writes, download length
  verified against `Content-Length` (skipped for compressed bodies).

## [0.1.0]

- Initial release: build an Android Gradle project folder into an APK,
  auto-downloading missing JDK / Android SDK / Gradle into the workspace
  download folder, with non-ASCII (CJK) path staging for AAPT2.
