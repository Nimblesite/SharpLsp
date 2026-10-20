// Prints, joined by "|", the VS Code profiles that hold their own copy of an
// extension, so the local install loop replaces SharpLsp in every profile that
// runs it, not only the default one. Implements [DIST-VSIX-DEV-INSTALL].
//
//   node tools/vsix/vscode-profiles.mjs <extension id>
//
// VS Code's user data directory is found per platform, or set with
// VSCODE_USER_DATA_DIR. A profile that shares the default profile's extensions
// is left out: installing into the default profile reaches it already.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function userDataDir() {
  if (process.env.VSCODE_USER_DATA_DIR) return process.env.VSCODE_USER_DATA_DIR;
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", "Code");
  if (process.platform === "win32")
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Code");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "Code");
}

/** The parsed JSON at `file`, or `undefined` when it is absent or unreadable. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function holds(extensionsFile, id) {
  const extensions = readJson(extensionsFile);
  return (
    Array.isArray(extensions) &&
    extensions.some((entry) => entry?.identifier?.id?.toLowerCase() === id)
  );
}

const id = (process.argv[2] ?? "").toLowerCase();
if (!id) {
  process.stderr.write("usage: node tools/vsix/vscode-profiles.mjs <extension id>\n");
  process.exit(2);
}
const user = path.join(userDataDir(), "User");
const storage = readJson(path.join(user, "globalStorage", "storage.json"));
const profiles = Array.isArray(storage?.userDataProfiles) ? storage.userDataProfiles : [];
const names = profiles
  .filter((profile) => profile.useDefaultFlags?.extensions !== true)
  .filter((profile) => holds(path.join(user, "profiles", profile.location, "extensions.json"), id))
  .map((profile) => profile.name);
process.stdout.write(names.join("|"));
