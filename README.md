# dsh-plugin-android-apk

DeepSeek Harness (DSH) 插件：把一个安卓项目文件夹直接构建成 APK。
缺少的工具链（JDK / Android SDK / Gradle）会自动**下载到工作文件夹内**，不污染用户目录。

> 更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 功能

- 识别 Gradle 安卓工程（`settings.gradle` / `settings.gradle.kts` / `build.gradle`），可选支持 Gradle Wrapper。
- 自动准备工具链：
  - **JDK**：系统 `JAVA_HOME`/`PATH` 里有满足要求的 Java（AGP 8 / Gradle 8 需要 ≥17，否则 ≥11，插件会先探测工程里的 AGP 版本）就直接用；否则按**当前系统与架构**下载对应的 Temurin JDK（Windows/Linux/macOS × x64/aarch64…，Windows 取 `.zip`、其它取 `.tar.gz`）到下载文件夹，**并复用上次下载的 JDK，不重复下载**。若请求的版本在该平台没有官方构建（例如 Temurin 没有 windows/aarch64 的 JDK 17），会自动沿 LTS 阶梯回退到有构建的版本（17 → 21 → 25）并在日志里说明原因。
  - **Android SDK**：依次检查 `local.properties` 的 `sdk.dir`、`ANDROID_HOME`、`ANDROID_SDK_ROOT`、`%LOCALAPPDATA%\Android\Sdk`；都没有则下载 commandline-tools + platform-tools + build-tools + platform 到下载文件夹，并自动写入 `local.properties` 和接受许可。`local.properties` 里失效的 `sdk.dir`（指向已删除的 SDK）会被自动修正。
  - **Gradle**：工程带可用 Wrapper 就用 Wrapper（若 Wrapper 的 Gradle 版本无法在当前 JDK 上运行，例如 Gradle 7.0 配 Java 17，则自动改为下载发行版）；否则按 `gradle-wrapper.properties` 里的版本（或配置的 `gradleVersion`）下载发行版。
- 运行 `assemble<Variant>`（默认 `debug`，可用 `release`），把产物 APK 复制到输出文件夹。
- **非 ASCII 路径自动处理**：当工程或 SDK 目录路径含有非 ASCII 字符（例如中文路径，AAPT2 在 Windows 上会因此无法读取 `android.jar`）时，自动把工程和 SDK 复制到一个可用的 ASCII 临时目录（`%TEMP%\dsh-android-build`）里构建，再把 APK 复制回你的输出文件夹。staged SDK 会缓存复用，不重复下载。
- 所有下载、Gradle 发行版、依赖缓存（`GRADLE_USER_HOME`）都放在**插件自己的 `toolchain/` 目录**（`<插件安装目录>/toolchain`，可用 `downloadDir` 覆盖）。放在插件根目录意味着**所有会话、所有工程共用同一套工具链**——不会每个工作区各留一份几百 MB 的缓存，也不污染用户目录。

## 安装

在 DSH 宿主机器上（需要 `pnpm` 在 PATH 上）。把 `<插件路径>` 换成这个 tarball 在你机器上的实际位置，
`<profile>` 换成你要装的 profile 名：

```bash
dsh plugin --profile <profile> add "<插件路径>/dsh-plugin-android-apk-0.2.4.tgz"
```

> **`<profile>` 填什么？** 桌面端常见的是 `desktop`，Web 端常见的是 `web`，但名字由你自己决定，
> 取决于当前跑的是哪个 profile——填错不会报错，只是"装到另一个 profile 去了"，当前会话看不到这个工具。
> 查看本机有哪些 profile：`ls ~/.dsh/profiles`（Windows：`dir %USERPROFILE%\.dsh\profiles`）。
> 想知道**当前**会话用的是哪个，可在任务管理器里看 DSH 主进程的命令行，末尾那个路径就是
> `...\.dsh\profiles\<名字>`。
>
> **插件与 profile 无关**：`cordis.patch.yml` 按包名插入一行插件，代码里没有写死任何 profile 名，
> 所以 `desktop` / `web` / 自定义 profile 都同样可用。唯一的差别是**每个 profile 要各装一次**——
> 它属于 profile 级依赖；如果你同时用桌面端和 Web 端（通常就是两个 profile），两边都装才会都出现。

> 说明：`dsh plugin` 实际是在 profile 目录里执行 `pnpm add <spec>`，然后把声明了
> `dsh.bundle.patch` 的包加入 `dsh.profile.bundles` 层。手动操作等价于：
> 在 `~/.dsh/profiles/<profile>` 执行 `pnpm add <spec>`，再把包名加进
> `package.json` 的 `dsh.profile.bundles`。

> ⚠️ **依赖声明为 `peerDependencies`（0.2.1 起）**：`@deepseek-ai/cordis` /
> `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` 由 DSH 宿主提供并做解析拦截，
> 插件**不能**自己装一份——否则 profile 里的旧副本会遮蔽宿主自己的 `tools` 行，导致
> `1 required plugin did not activate`、桌面端无法启动。请不要在 profile 里手动
> `pnpm add` 这三个包。

## 使用

装好后，直接对 Agent 说“把 `xxx` 文件夹构建成 APK”，或显式调用工具：

```
build_android_apk(project="myapp", variant="debug", clean=false)
```

参数：

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `project` | 安卓工程文件夹路径（相对路径基于会话工作目录） | 必填 |
| `variant` | Gradle 变体（debug / release 等，大小写保留：`stagingDebug` → `assembleStagingDebug`） | `debug` |
| `clean` | 是否先 clean 全量重建 | `false` |
| `downloadDir` | 工具链下载目录（相对路径基于会话工作目录） | `<插件目录>/toolchain` |
| `apkOutputDir` | APK 复制目录 | `<workspace>/apk` |
| `gradleVersion` | 无可用 Wrapper 时下载的 Gradle 版本 | `8.9` |
| `compileSdk` | 覆盖自动检测的 compileSdk | 自动检测，未知时 34 |

返回：`ok`、`message`、`apks[]`（原始路径 + 复制路径 + 大小 + `staged` 标记）、`logTail`、`durationMs` 等。只返回**本次构建产出**的 APK（按修改时间过滤，不会把上次的旧包一起报上来）。

插件级配置（`cordis.patch.yml` 里的 `config`，可选）：

```yaml
config:
  defaultVariant: debug
  jdkMajor: 17
  gradleVersion: "8.9"
```

## 下载与镜像

| 组件 | 默认源 | 回退镜像 |
| --- | --- | --- |
| JDK (Temurin) | api.adoptium.net | mirrors.tuna.tsinghua.edu.cn/Adoptium |
| Gradle | services.gradle.org | mirrors.cloud.tencent.com/gradle、mirrors.aliyun.com |
| Android cmdline-tools | dl.google.com | mirrors.cloud.tencent.com/AndroidSDK |

网络受限（如国内直连 Google 不稳）时，插件会自动尝试回退镜像；也可以先用代理保证
`dl.google.com` / `services.gradle.org` / `api.adoptium.net` 可达。

**下载完整性校验**：拿得到上游官方摘要时会逐个比对，不匹配的镜像直接跳过并换下一个——

| 组件 | 校验来源 | 算法 |
| --- | --- | --- |
| JDK (Temurin) | Adoptium assets API 的 `checksum`（清华镜像为 `<归档>.sha256.txt`） | SHA-256 |
| Gradle | `<发行版>.sha256`（与 zip 同目录） | SHA-256 |
| Android cmdline-tools | Google `repository2-*.xml` 里的 `<checksum>` | SHA-1 / SHA-256 |

摘要源拿不到（镜像未提供、`dl.google.com` 不可达）时跳过校验、照常下载，不会阻塞构建；
校验通过会在 `logTail` 里打印 `[dl] … checksum verified …`。

## 目录结构

安装包（tarball）内包含：

```
package/
├── package.json        # dsh.bundle.patch 声明（profile 层识别依据）
├── cordis.patch.yml    # 插件行：android-apk-builder
├── lib/
│   ├── index.js        # Cordis 插件入口 + build_android_apk 工具定义
│   ├── build.js        # 构建编排（检测/下载/ASCII staging/assemble/复制 APK）
│   └── download.js     # 下载/解压/镜像回退/校验助手（仅用 Node 内置模块）
└── README.md
```

仓库里（不随 tarball 发布）：

```
package1/
├── CHANGELOG.md                          # 每个版本的改动记录（每次发版必更新）
├── RELEASES.txt                          # 发布台账：维护约定 + 各版本 tgz 的 SHA-256
├── dsh-plugin-android-apk-<version>.tgz  # 历史版本全部保留，不删除
└── test/
    ├── <最小 Android 工程>                # settings.gradle / app/ …，用于真实构建验证
    ├── run-build.mjs                     # 无头驱动：脱离 DSH 直接跑 buildApk
    └── progress-throttle.test.mjs        # 下载进度与监听器泄漏的回归测试
```

> `test/`、`CHANGELOG.md`、`RELEASES.txt` 与历史 tgz 都随 `package.json` 的 `files`
> 白名单排除，不会打进 tarball；它们只存在于源码仓库。

## 常见问题

- **构建失败 / 工具没出现**：安装后必须重启 DSH；`dsh plugin` 需要 `pnpm` 在 PATH。
- **工具报 `userRender is not a function` / 注册失败 / 输出被拒**：DSH 要求每个工具声明
 `output.render`（一个返回 `[{ type: "text", text }]` 数组的函数）。本插件自 0.2.1 起已内置；
 若你看到该错误，说明装的是旧版本，**升级到 ≥0.2.1**。同理 `apks[]` 的 `staged` 字段也已在
 `output.schema` 中声明（`additionalProperties: false` 下缺字段会导致 `INVALID_TOOL_OUTPUT`）。
- **装完 DSH 起不来（`1 required plugin did not activate` / `tools failed to import`）**：
  这是 0.2.0 及以前把 `@deepseek-ai/*` 写成 `dependencies` 导致的——pnpm 会往 profile 装一份
  旧的 `dsh-tools`，遮蔽宿主自己的 `tools` 行。**升级到 ≥0.2.1**（已改为 `peerDependencies`），
  并删除 profile 里的残留副本
  `~/.dsh/profiles/<profile>/node_modules/@deepseek-ai/dsh-tools`。
- **工程路径含中文/非 ASCII**：插件会自动 staging 到 ASCII 临时目录构建（并给 `gradle.properties`
  加 `android.overridePathCheck=true`），无需手动处理；staged SDK 会缓存复用，APK 仍复制回你的输出文件夹。
- **依赖下载超时**：Gradle 依赖（AGP、AndroidX）从 `dl.google.com` 拉取，网络不稳时可能超时；
  插件使用下载文件夹里已缓存的依赖，可先手动 `gradle assembleDebug` 预热，或配置代理。
- **下载很慢**：首次会拉取 JDK（约 180MB）+ cmdline-tools（约 150MB）+ Gradle（约 130MB），
  后续复用插件 `toolchain/` 里的缓存；依赖缓存也在该目录（`gradle-user-home`）。
- **插件升级后要重新下载工具链**：`toolchain/` 在插件自己的目录里，而 pnpm 升级插件时会重建该目录，
  所以升版本会丢掉缓存（约 460MB 需重下）。想让它跨版本存活，就在 `cordis.patch.yml` 里把
  `downloadRoot` 指到一个固定路径（如 `D:/android-toolchain`），或用工具参数 `downloadDir`。
- **build-tools 版本不匹配**：插件从 `sdkmanager --list` 里挑与 compileSdk 同大版本的最新
  build-tools；可传 `compileSdk` 覆盖检测结果。
- **老工程需要 JDK 8/11**：插件会先探测工程里的 AGP / Gradle 版本来推断所需 JDK（AGP 8、Gradle 8 → 17；否则 11）：系统 JDK 满足就直接用，不满足才下载，且下载版本不会低于该要求（`jdkMajor` 只在需要下载时生效）。需要 JDK 8 的老工程请自行配好 `JAVA_HOME`（插件最低要求 Java 11）。
- **非 Windows / Linux / Termux 宿主**：构建路径已平台化，非 Windows 下 Java 用 `java`（`which` 定位）、
 sdkmanager 用 `sdkmanager` 脚本（自动 `chmod +x`）、Gradle 用 `gradlew`/`gradle`，下载按
 平台取 Adoptium 三元组（Linux/macOS 为 `.tar.gz`），解压回退链为 `unzip → python3 -m zipfile → tar`。
 社区已在 **Termux (aarch64, Android 15)** 上端到端跑通：`ok: true`、产出真实 APK（含
 `classes.dex` / `AndroidManifest.xml` 等）。注意该实测用的是**预装**的 JDK 21 + SDK 34.0.4，
 Linux 上"从零下载 SDK"那条路径未被该次实测覆盖。
