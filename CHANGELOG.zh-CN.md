# 更新日志（简体中文）

`dsh-plugin-android-apk` 的所有重要变更都记录在此文件。

> 英文原版：[`CHANGELOG.md`](CHANGELOG.md)
> 格式：[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
> 版本号：[语义化版本](https://semver.org/lang/zh-CN/)。
> 发布台账（各版本 tgz 名称与 SHA-256）：[`RELEASES.txt`](RELEASES.txt)。

> **维护规则：每次改动都要升版本号，并在打包前先在此文件写下对应小节；
> 已发布的 tarball 永不删除。中英文两版必须同步更新。**

## [0.2.4] - 2026-10-01

### 变更

- **工具链改为下载到插件自己的包目录（`<插件目录>/toolchain`），不再放
  `<workspace>/.android-build`。** 这样一套工具链被**所有会话、所有工程共用**，
  不会每个工作区各留一份约 460MB 的 JDK + SDK + Gradle 下载（外加
  `gradle-user-home` 依赖缓存）。该位置由模块 URL 推导，因此无论 profile 把包装在哪里
  （包括装在 `node_modules` 里）都是对的；显式的 `downloadDir` 参数或 `downloadRoot`
  配置仍然优先，且相对值仍按会话工作目录解析。
  若插件目录不可写（只读安装），插件会打日志说明并回退到 `<workspace>/.android-build`，
  而不是直接失败。
  ⚠ 由于该目录位于包内部，升级插件时会重建该目录、已缓存的工具链会丢失；
  想跨版本保留，请把 `downloadRoot` 指到一个固定路径。
- `apkOutputDir` 默认值未变——产物 APK 仍然落在 `<workspace>/apk`，方便调用方查找。
- 工具描述、参数说明、配置注释、`package.json` 的 `description` 字段与 README
  均按新的默认位置做了更新。

### 新增

- `test/download-dir.test.mjs`——验证：默认值为插件根目录下的路径、且是绝对路径并位于
  包内；相对与绝对的 `downloadDir` 覆盖都生效；`config.downloadRoot` 被尊重；
  工具参数优先于配置值。

## [0.2.3] - 2026-10-01

### 修复

- **请求的 JDK 在该平台没有官方构建时，取不到 JDK。** Temurin **没有
  `windows/aarch64` 的 JDK 17**（经 Adoptium assets API 验证：17 为 `builds=0`，
  21 为 `builds=1`），因此在没有系统 Java 的 Windows-ARM 机器上，所有 JDK 候选地址
  都返回 404，构建以"所有下载镜像都失败"告终。现在插件会通过 assets API 解析实际可用的
  特性版本，当请求的版本在本平台/架构无构建时，沿一个小型 LTS 阶梯
  （17 → 21 → 25）回退，并在日志中说明：

  ```
  [jdk] Temurin 17 has no win32/arm64 build — falling back to Temurin 21
  [jdk] downloading Temurin JDK 21 (win32/arm64) …
  ```

  解析出的版本会**钉住所有**候选地址（assets API 条目、纯 endpoint、清华镜像目录列表），
  因此镜像回退绝不会悄悄取到与已校验哈希不同的版本。只有当 API 可达且明确回答"无构建"时
  才会走阶梯——若 API 本身不可达，则保留请求的版本，纯 endpoint 与镜像候选仍然有效。
- **32 位 x86 解析成了 Adoptium 不存在的架构名。** `process.arch` 报 `ia32`，
  而 Adoptium 把该架构命名为 `x86`，导致 JDK 地址 404。已补上 `ia32 → x86` 映射。

### 新增

- `test/jdk-version-fallback.test.mjs`——阶梯逻辑的离线测试：请求版本缺失时回退；
  请求版本存在时**不**回退；API 不可达时保留请求版本；API 挂掉时仍能发现镜像候选；
  以及 `ia32 → x86` 映射。
- `test/platform-matrix.mjs`——覆盖六种平台/架构组合（通过覆写 `process.platform` /
  `process.arch`）解析工具链地址，并对 Adoptium API 做真实探测，因此无需拥有那些机器
  也能在每次改动后复验平台覆盖。

### 验证

- 请求 JDK 17 的真实 Adoptium 解析结果：`win32/x64`、`linux/x64`、`linux/arm64`、
  `darwin/x64`、`darwin/arm64` → **按请求得到 17**；`win32/arm64` → **21（回退）**。
  解析出的每个产物、以及三个 `commandlinetools-{win,linux,mac}` 归档均探测成功。
- Windows x64 端到端构建仍然通过（见 0.2.2），两套测试全过
  （`progress-throttle` 9 条断言、`jdk-version-fallback` 13 条断言）。

## [0.2.2] - 2026-10-01

由第一次真实端到端构建（从零配置约 1.1GB 工具链：Temurin JDK 17 + Android SDK 34 +
Gradle 8.9）发现。

### 修复

- **下载进度刷屏，淹没构建日志。** `progressLogger` 里有个"补一条收尾日志"的旁路
  （`received >= total`），它会在此后**每一个**剩余数据块上持续成立。镜像返回压缩响应时，
  声明的 `Content-Length` 是压缩后大小，而统计的是解压后字节数，于是 `received` 很早就
  超过了 `total`：一次 127MB 的下载（gzip 解压后 146MB）产生了 **约 5,100 行日志**，
  把有用输出挤出了 300KB 的日志尾部。现在改为每 32MB 一行，外加恰好一行收尾日志，
  由 `downloadFile` 通过新增的 `final` 回调参数发出信号。
- **`downloadFile` 泄漏写流 `error` 监听器。** 背压等待里注册了
  `ws.once("error", resolveWrite)`；当 `drain` 正常触发时该监听器永远不会被移除，
  于是一次大下载会累积成千上万个，触发 Node 的 `MaxListenersExceededWarning`
  （实测在 11+ 时告警）。现在等待结束时两个监听器都会被移除。

### 新增

- `test/progress-throttle.test.mjs`——针对上述两个 bug 的离线回归测试
  （节流、唯一收尾行、无监听器泄漏、下载契约）。
- `test/run-build.mjs`——无头驱动脚本，在 DSH 之外直接运行插件自己的 `buildApk`，
  因此无需重启 DSH 就能跑真实构建路径。
- `test/`——一个最小 Android 工程（单 Activity、仅用系统框架、无 AndroidX），
  用于压测资源 + AAPT2、ASCII staging 路径、以及 SDK/build-tools 的选择。
- `RELEASES.txt`——发布台账与本包的维护约定。

### 变更

- `README.md` 的安装章节改用 `--profile <profile>` 占位，不再写死 `web`；
  并补充了如何找到当前 profile、以及"每个 profile 各装一次"的说明
  （插件属于 profile 级依赖）。
- `progressLogger` 改为导出，以便测试。

## [0.2.1] - 2026-10-01

### 修复

- **安装插件后 DSH 无法启动**（`DesktopHostFatalError: dsh: startup failed: 1 required
  plugin did not activate`，`tools` → *failed to import*，7 个插件在等待 `tools`；
  启动失败的恢复流程还可能重置用户的 `cordis.patch.yml` / `dsh.profile.bundles`）。
  `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 被声明为
  `dependencies`，于是 pnpm 往 profile 里装了一份副本。这份 `dsh-tools` 副本本身就无法
  import（`autoInstallPeers: false` 使其 8 个 `@deepseek-ai/dsh-*` peer 未安装），
  版本比宿主的旧，且解析顺序靠前——遮蔽了宿主自己的 `tools` 服务。DSH 通过
  "宿主安装提供 + 解析拦截"提供这些包，期望插件以 peer 声明。三者已全部移到
  `peerDependencies`，并把 `@deepseek-ai/dsh-tools` 放宽为 `>=0.1.0-rc.6 <2`，
  避免宿主演进时被判不兼容。插件代码零改动。
  → 已修复于 [issue #2](https://github.com/memories-coder/DSH-plugin-android-apk/issues/2)。
- **工具注册失败，报 `userRender is not a function`**，且构建成功的输出被宿主的
  schema/render 校验拒绝。宿主的 `harness.defineTool` 要求 `output` 为
  `{ schema, render }`，但此前只声明了 `schema`。已补上
  `render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]`
  ——与 profile 中其它所有插件一致的签名与 content block 返回结构。
  属于 [PR #1](https://github.com/memories-coder/DSH-plugin-android-apk/pull/1)。
- **Linux / Termux 构建路径**（来自社区 PR）：平台感知的 Java / Gradle / sdkmanager
  启动器、Adoptium OS/arch URL 三元组、`unzip → python3 -m zipfile → tar` 解压链，
  以及 `taskkill` / `cmd.exe` / `powershell` 守卫，使构建器可在 Windows 之外工作。
  已在 Termux（aarch64，Android 15）端到端验证。
  → [PR #1](https://github.com/memories-coder/DSH-plugin-android-apk/pull/1)。
- **`findApks` 忽略 variant。** `build/outputs/apk` 下的每个 APK 都被当成本次运行的产出，
  包括其它 variant 的残留。现在按请求 variant 的文件名标记过滤
  （`-debug.apk`、`app-free-debug.apk` 匹配 `debug`；`app-release.apk` 不匹配）。
- **并发构建可能互相清空对方的 staging 目录。** staged SDK 是个会被清空并重新复制的
  共享目录；两个构建指向同一 ASCII 根目录时可能同时这样做。现在 staging 由跨进程锁串行化
  （独占创建的锁文件记录持有者 pid），当持有者被确认已死、或锁超过 5 分钟时会被抢占，
  因此崩溃的构建不会卡住后续运行。
- **成功路径从未释放 response reader。** 只有错误路径会 cancel，导致下载结束后流句柄仍然存活。
- **不完整的 staged SDK 可能被当作完整而缓存。** `copyPathIfPresent` 会静默跳过缺失的源，
  因此当 staged SDK 缺少 `platforms` / `build-tools` / `platform-tools` 时仍可能写入缓存标记，
  之后每次运行都会复用它。现在只有在这三者都验证为非空后才写标记。

### 安全

- **在上游提供摘要时，对下载的工具链产物做哈希校验**，不再只信任 HTTPS 与镜像本身。
  不匹配即删除文件并切换到下一个镜像：
  - JDK：以 Adoptium assets API 的 `checksum`（SHA-256）为主，另加清华镜像的
    `<归档>.sha256.txt`；
  - Gradle：与 zip 同目录的 `<发行版>.sha256`；
  - Android cmdline-tools：Google `repository2-*.xml` 中该归档的 `<checksum>`。
  摘要源按"尽力而为"解析（有界、可中断的请求）；当其不可用时跳过校验照常下载，
  不阻塞构建。校验通过会打印 `[dl] … checksum verified …`。三项校验均已在 0.2.2 的
  端到端运行中实测通过。

### 新增

- README 的 FAQ 补充了 `userRender` 失败与 `peerDependencies` 要求两条，
  并给出 profile 中已存在遮蔽副本 `node_modules/@deepseek-ai/dsh-tools` 时的恢复步骤。

## [0.2.0]

### 修复

- **系统 Java 从未被检测到。** `findSystemJava()` 调用 `runCommand()` 时漏了 `await`，
  读到的是 `Promise` 而非命令输出，于是永远报告"没有可用 Java"。每次运行都重新下载
  Temurin JDK（约 180MB）且忽略 `JAVA_HOME`。
- **`readFileSync` 从未被 import。** staged SDK 的缓存 key 每次都静默回退为空串。
- **`clean: true` 向 Gradle 传了 `--clean`**，这不是合法的 Gradle 命令行选项、会立即失败。
  现在改为在同一 invocation 中先执行 `clean` 任务。
- **变体名被小写化**，`stagingDebug` 会变成 `assembleStagingdebug`。现保留大小写
  （`assembleStagingDebug`）。
- **`apks[].copiedTo` 在复制失败时可能指向错误文件**，因为 copied 数组是按索引配对的。
  现改为按源路径映射；两个模块产出同名文件也不再互相覆盖。
- **`extractZip` 在块外引用 `tar`**，在 POSIX 错误路径抛 `ReferenceError`，且唯一回退是
  PowerShell（POSIX 上不存在）。回退链现在是：Windows `tar` → `Expand-Archive`，
  其它平台 `unzip` → `python3 -m zipfile` → `tar`。
- **下载可能挂死或静默损坏。** 写流的 `error` 事件从未被监听（磁盘满时 promise 永不落定），
  截断的响应体被当成完整，失败的镜像还残留半截文件。
- **`sdkmanager --list` 输出被 400KB 日志尾缓冲截断**，build-tools/platform 行经常缺失、
  只装了 `platform-tools`。该调用的缓冲已按需放大，装完后还会校验目录布局。
- **`local.properties` 可能钉住一个失效的 `sdk.dir`。** 它用 `flag: "wx"` 写入，指向已删除
  SDK 的条目永远不会被修正——而 AGP 优先读 `local.properties` 而非 `ANDROID_HOME`。
  失效条目现在会被检测并重写。
- **Windows 硬编码**（`java.exe`、`sdkmanager.bat`、`commandlinetools-win-*`、`taskkill`）
  使文档宣称的 POSIX 支持不可能实现。现已全部平台感知，含 Temurin 的 OS/arch URL 三元组
  与归档后缀。
- **`output.schema` 漏掉了工具会返回的 `staged` 字段**，而它声明了
  `additionalProperties: false`。
- **`spawn()` 同步失败未被捕获**，`where java` / `which java` 返回空会让
  `findSystemJava()` 崩溃。
- **`compileSdk: 0` 被直接透传**，而不是回退到自动检测。

### 变更

- 所需 JDK 现在**由工程推断**（AGP 8 / Gradle 8 → Java 17，否则 11），
  不再假定"Java ≥ 11 就行"。系统 JDK 满足要求时直接使用；否则下载版本会被抬高到匹配。
- **Wrapper 的 Gradle 版本无法在所选 JDK 上运行时**（如 Gradle 7.0 配 Java 17）会被跳过，
  改用下载的发行版。
- `apks[]` 现在只包含**本次运行**产出的 APK（mtime 过滤，无匹配时记录日志回退）。
- `README.md` 与打包 tarball 名称更新到 `0.2.0`。

### 优化

- **不再重复下载：** 已下载的 JDK 会被复用（按所需 Java 版本判定），已有 `cmdline-tools`
  也直接复用、不再重拉约 150MB。临时归档以 `pid + 时间戳` 命名，并发调用不冲突。
- **ASCII staging** 目录改为 `<工程名>-<hash>`（不再是固定的 `sample-app`），且 staged 副本
  会跳过 `build/`、`.gradle/`、`.git/`、`.idea/`、`.cxx/`——复制更快，也不会把陈旧 APK
  带进构建目录。
- **staged SDK 的缓存失效**改为按真实的 `platforms/` 与 `build-tools/` 目录列表判定，而非常量。
- **下载进度**每约 32MB 记录一行；中止信号会立即停止镜像轮询，而非在死连接上重试。
- **失败信息可操作：** 装完缺 platform/build-tools、`--list` 解析不出、发行版解压后缺启动器，
  现在都会明确报错，而不是静默再触发一整轮下载。
- 细节加固：`path.delimiter` 取代手写分隔符、`spawn()` 错误加保护、`local.properties`
  写入记录日志、按 `Content-Length` 校验下载长度（压缩响应体跳过）。

## [0.1.0]

- 首个版本：把一个安卓 Gradle 工程文件夹构建成 APK，自动把缺失的 JDK / Android SDK /
  Gradle 下载到工作文件夹，并支持非 ASCII（中文）路径的 staging 以规避 AAPT2 问题。
