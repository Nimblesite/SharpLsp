// Shared typediagram CLI runner for model generators ([TUTORIAL-MODEL], [FIXALL-MODEL]).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The CLI's whole stdout, captured through a file: a macOS pipe drops output
 * past its buffer when the CLI exits straight after writing.
 */
export function captureStdout(command, args) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typediagram-"));
    const file = path.join(dir, "stdout");
    const fd = fs.openSync(file, "w+");
    try {
        execFileSync(command, args, { stdio: ["ignore", fd, "inherit"] });
        const buffer = Buffer.alloc(fs.fstatSync(fd).size);
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
        return buffer.toString("utf8", 0, bytesRead);
    } finally {
        fs.closeSync(fd);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * The typediagram CLI as `[command, args]`. On Windows npm installs it as a
 * `.cmd` shim, which Node runs only through a shell; resolve its JS entry
 * directly instead.
 */
export function typediagramCommand(args) {
    if (process.platform !== "win32") return ["typediagram", args];
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const prefix = dirs.find((dir) => fs.existsSync(path.join(dir, "typediagram.cmd")));
    if (prefix === undefined) throw new Error("typediagram is not on PATH: npm install -g typediagram");
    const manifest = path.join(prefix, "node_modules", "typediagram", "package.json");
    const { bin } = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const entry = typeof bin === "string" ? bin : bin.typediagram;
    return [process.execPath, [path.join(path.dirname(manifest), entry), ...args]];
}

/** Run `typediagram --to <lang> <source>` and return its emitted source text. */
export function emitTypeDiagram(lang, source) {
    return captureStdout(...typediagramCommand(["--to", lang, source]));
}

/** Read a file if present, or "" before its first generation. */
export function readCurrentFile(filePath) {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") return "";
        throw error;
    }
}

/** Write or verify a generated file according to `--check`. */
export function syncGeneratedFile(root, target, generated, checkMode, toolName) {
    const current = readCurrentFile(target);
    const rel = path.relative(root, target);
    if (checkMode) {
        if (current !== generated) {
            process.stderr.write(`${rel} is stale: run node tools/vsix/${toolName}\n`);
            return false;
        }
        return true;
    }
    if (current !== generated) {
        fs.writeFileSync(target, generated, "utf8");
        process.stdout.write(`${toolName}: wrote ${rel}\n`);
    }
    return true;
}
