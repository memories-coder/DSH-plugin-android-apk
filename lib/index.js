// dsh-plugin-android-apk — Cordis plugin entry.
//
// Registers the `build_android_apk` tool: point it at an Android Gradle
// project folder and it assembles an APK, downloading any missing JDK /
// Android SDK / Gradle pieces into the workspace download folder.
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { buildApk } from "./build.js";

export const name = "android-apk-builder";
export const inject = ["tools"];

/** Runtime configuration schema (editable from the profile's cordis layer). */
export const Config = z.object({
	/** Default Gradle variant when the tool call does not pass one. */
	defaultVariant: z.string().default("debug"),
	/** Folder for downloaded toolchain pieces; defaults to <workspace>/.android-build. */
	downloadRoot: z.string().default(""),
	/** Folder for copied APKs; defaults to <workspace>/apk. */
	apkOutputDir: z.string().default(""),
	/** JDK major version to download when no usable system java exists. */
	jdkMajor: z.number().default(17),
	/** Gradle version to download when the project has no usable wrapper. */
	gradleVersion: z.string().default("8.9"),
	/** compileSdk override when auto-detection is not wanted. */
	compileSdk: z.number().default(0)
});

const outputSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		ok: { type: "boolean", required: true },
		message: { type: "string" },
		apks: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					bytes: { type: "integer" },
					copiedTo: { type: "string" }
				}
			}
		},
		downloadsDir: { type: "string" },
		jdk: { type: "string" },
		sdk: { type: "string" },
		gradle: { type: "string" },
		logTail: { type: "string" },
		durationMs: { type: "integer" }
	}
};

export function apply(ctx, config = {}) {
	ctx.tools.register(
		defineTool({
			name: "build_android_apk",
			description: [
				"Build an Android Gradle project folder into an APK (debug by default).",
				"The tool detects the project (settings.gradle / build.gradle + optional Gradle wrapper),",
				"ensures the toolchain, and runs `assemble<Variant>`.",
				"Missing pieces are downloaded automatically into the workspace download folder",
				"(default `<workspace>/.android-build`, see `downloadDir`): a Temurin JDK when no usable",
				"system java exists, the Android SDK commandline-tools + platform-tools + build-tools +",
				"platform when no SDK is found (ANDROID_HOME / local.properties / default location), and a",
				"Gradle distribution when the project has no usable wrapper. Gradle caches are redirected",
				"into the same download folder (GRADLE_USER_HOME).",
				"On success the produced APK(s) under `**/build/outputs/apk` are copied to the APK output",
				"folder (default `<workspace>/apk`). Downloads may be large and slow on first run;",
				"subsequent runs reuse what was downloaded. Use `clean: true` for a clean build.",
				"Relative project/download paths resolve against the session workspace."
			].join(" "),
			parameters: {
				project: {
					type: "string",
					required: true,
					description: "Path to the Android project folder (must contain settings.gradle / settings.gradle.kts / build.gradle). Relative paths resolve against the session workspace."
				},
				variant: {
					type: "string",
					description: "Gradle variant to assemble, e.g. \"debug\" or \"release\". Default: \"debug\"."
				},
				clean: {
					type: "boolean",
					description: "Run gradle --clean first (full rebuild). Default: false."
				},
				downloadDir: {
					type: "string",
					description: "Folder to download missing toolchain pieces (JDK / Android SDK / Gradle) into. Default: <workspace>/.android-build."
				},
				apkOutputDir: {
					type: "string",
					description: "Folder to copy built APKs into. Default: <workspace>/apk."
				},
				gradleVersion: {
					type: "string",
					description: "Gradle version to download when the project has no usable wrapper (e.g. \"8.9\"). Default: \"8.9\"."
				},
				compileSdk: {
					type: "integer",
					description: "Override the detected compileSdk used to pick Android SDK platform/build-tools. Default: auto-detected, 34 when unknown."
				}
			},
			output: { schema: outputSchema },
			execute: (args, exec) => buildApk(args, exec, config),
			presentCall: (args) => ({
				card: "generic",
				title: `build_android_apk ${args.project}${args.variant ? ` (${args.variant})` : ""}`,
				kind: "execute",
				rawInput: args.project
			})
		})
	);
}
