import * as path from "node:path";
import { workspace, window } from "vscode";
import * as log from "./log.js";

/** Result of solution discovery. */
export interface SolutionSelection {
    /** Absolute path to the chosen .sln file. */
    readonly path: string;
    /** Display name (filename without extension). */
    readonly name: string;
}

/** Discover .sln files in the workspace and let the user pick if needed. */
export async function selectSolution(): Promise<SolutionSelection | undefined> {
    const solutions = await findSolutions();

    if (solutions.length === 0) {
        log.info("No .sln files found in workspace.");
        window.showInformationMessage(
            "Forge: No .sln files found in this workspace.",
        );
        return undefined;
    }

    if (solutions.length === 1) {
        const [selected] = solutions;
        if (selected !== undefined) {
            log.info(`Auto-selected solution: ${selected.path}`);
            return selected;
        }
    }

    return promptUserSelection(solutions);
}

/** Prompt the user to pick from multiple solutions. */
export async function promptUserSelection(
    solutions: readonly SolutionSelection[],
): Promise<SolutionSelection | undefined> {
    const items = solutions.map((sol) => ({
        label: sol.name,
        description: sol.path,
        solution: sol,
    }));

    const picked = await window.showQuickPick(items, {
        placeHolder: "Select a solution to open",
        title: "Forge: Multiple solutions found",
    });

    if (picked === undefined) {
        log.info("User cancelled solution selection.");
        return undefined;
    }

    log.info(`User selected solution: ${picked.solution.path}`);
    return picked.solution;
}

/** Find all .sln files across workspace folders. */
async function findSolutions(): Promise<SolutionSelection[]> {
    const folders = workspace.workspaceFolders;
    if (folders === undefined || folders.length === 0) {
        return [];
    }

    const pattern = "**/*.sln";
    const excludePattern = "**/node_modules/**";
    const uris = await workspace.findFiles(pattern, excludePattern, 50);

    return uris
        .map((uri) => ({
            path: uri.fsPath,
            name: path.basename(uri.fsPath, ".sln"),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
}
