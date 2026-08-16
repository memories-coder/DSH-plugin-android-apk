# dsh-plugin-android-apk

DeepSeek Harness (DSH) 插件：把一个安卓项目文件夹直接构建成 APK。
缺少的工具链（JDK / Android SDK / Gradle）会自动**下载到工作文件夹内**，不污染用户目录。

## 功能

- 识别 Gradle 安卓工程（`settings.gradle` / `settings.gradle.kts` / `build.gradle`），可选支持 Gradle Wrapper。
- 自动准备工具链：
  - **JDK**：系统 `JAVA_HOME`/`PATH` 里有 ≥11 的 Java 就直接用；否则下载 Temurin JDK（默认 17）到下载文件夹。
  - **Android SDK**：依次检查 `local.properties` 的 `sdk.dir`、`ANDROID_HOME`、`ANDROID_SDK_ROOT`、`%LOCALAPPDATA%\Android\Sdk`；都没有则下载 commandline-tools + platform-tools + build-tools + platform 到下载文件夹，并自动写入 `local.properties` 和接受许可。
  - **Gradle**：工程带可用 Wrapper 就用 Wrapper；否则按 `gradle-wrapper.properties` 里的版本（或配置的 `gradleVersion`）下载发行版。
- 运行 `assemble<Variant>`（默认 `debug`，可用 `release`），把产物 APK 复制到输出文件夹。
- **非 ASCII 路径自动处理**：当工程或 SDK 目录路径含有非 ASCII 字符（例如中文路径，AAPT2 在 Windows 上会因此无法读取 `android.jar`）时，自动把工程和 SDK 复制到一个可用的 ASCII 临时目录（`%TEMP%\dsh-android-build`）里构建，再把 APK 复制回你的输出文件夹。staged SDK 会缓存复用，不重复下载。
- 所有下载、Gradle 发行版、依赖缓存（`GRADLE_USER_HOME`）都放在下载文件夹里，默认是**会话工作目录下的 `.android-build`**。

## 安装

在 DSH 宿主机器上（需要 `pnpm` 在 PATH 上）。把 `<插件路径>` 换成这个 tarball 在你机器上的实际位置：

```bash
dsh plugin --profile web add "<插件路径>/DSH-plugin-android-apk-main"
```

> 说明：`dsh plugin` 实际是在 profile 目录里执行 `pnpm add <spec>`，然后把声明了
> `dsh.bundle.patch` 的包加入 `dsh.profile.bundles` 层。手动操作等价于：
> 在 `~/.dsh/profiles/web` 执行 `pnpm add <spec>`，再把包名加进
> `package.json` 的 `dsh.profile.bundles`。
> 有问题随时提issues
## 使用

装好后，直接对 Agent 说“把 `xxx` 文件夹构建成 APK”，或显式调用工具：

```
build_android_apk(project="myapp", variant="debug", clean=false)
```

参数：

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `project` | 安卓工程文件夹路径（相对路径基于会话工作目录） | 必填 |
| `variant` | Gradle 变体（debug / release） | `debug` |
| `clean` | 是否先 clean 全量重建 | `false` |
| `downloadDir` | 工具链下载目录 | `<workspace>/.android-build` |
| `apkOutputDir` | APK 复制目录 | `<workspace>/apk` |
| `gradleVersion` | 无可用 Wrapper 时下载的 Gradle 版本 | `8.9` |
| `compileSdk` | 覆盖自动检测的 compileSdk | 自动检测，未知时 34 |

返回：`ok`、`message`、`apks[]`（原始路径 + 复制路径 + 大小）、`logTail`、`durationMs` 等。

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

## 目录结构

安装包（tarball）内包含：

```
package/
├── package.json        # dsh.bundle.patch 声明（profile 层识别依据）
├── cordis.patch.yml    # 插件行：android-apk-builder
├── lib/
│   ├── index.js        # Cordis 插件入口 + build_android_apk 工具定义
│   ├── build.js        # 构建编排（检测/下载/ASCII staging/assemble/复制 APK）
│   └── download.js     # 下载/解压/镜像回退助手（仅用 Node 内置模块）
└── README.md
```

> 源码仓库在 `test/` 下还保留开发用的单元/端到端测试脚本，但它们不属于安装包，随 `package.json` 的 `files` 白名单排除，不会打进 tarball。

## 常见问题

- **构建失败 / 工具没出现**：安装后必须重启 DSH；`dsh plugin` 需要 `pnpm` 在 PATH。
- **工程路径含中文/非 ASCII**：插件会自动 staging 到 ASCII 临时目录构建（并给 `gradle.properties`
  加 `android.overridePathCheck=true`），无需手动处理；staged SDK 会缓存复用，APK 仍复制回你的输出文件夹。
- **依赖下载超时**：Gradle 依赖（AGP、AndroidX）从 `dl.google.com` 拉取，网络不稳时可能超时；
  插件使用下载文件夹里已缓存的依赖，可先手动 `gradle assembleDebug` 预热，或配置代理。
- **下载很慢**：首次会拉取 JDK（约 180MB）+ cmdline-tools（约 150MB）+ Gradle（约 130MB），
  后续复用 `.android-build` 里的缓存；依赖缓存也在该目录（`gradle-user-home`）。
- **build-tools 版本不匹配**：插件从 `sdkmanager --list` 里挑与 compileSdk 同大版本的最新
  build-tools；可传 `compileSdk` 覆盖检测结果。
- **老工程需要 JDK 8/11**：把 `jdkMajor` 改为 `11`（或 `8`），或提前配好 `JAVA_HOME`。
- **非 Windows 宿主**：插件同样可用（gradlew/gradle 脚本 + tar 解压 + Expand-Archive 回退）。
