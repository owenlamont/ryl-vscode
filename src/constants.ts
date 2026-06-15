import * as path from "node:path";

/** Settings namespace, command prefix, and LanguageClient id. */
export const EXTENSION_ID = "ryl";

/** Human-readable server name shown in output channels and the client. */
export const SERVER_NAME = "ryl Language Server";

/** Platform-specific filename of the ryl executable. */
export const RYL_BINARY_NAME = process.platform === "win32" ? "ryl.exe" : "ryl";

/** Subcommand that runs the language server over stdio. `ryl server` takes no flags. */
export const SERVER_SUBCOMMAND = "server";

/**
 * Path to the ryl binary bundled in the packaged extension. The build output
 * lives in `dist/`, so the binary downloaded into `bundled/` at package time is
 * one directory up from this module at runtime.
 */
export const BUNDLED_RYL_PATH = path.join(__dirname, "..", "bundled", RYL_BINARY_NAME);
