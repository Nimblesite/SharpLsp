// The entry-point guard every tools/vsix script shares: a thrown error is one
// line on stderr and exit code 1, never a stack trace in a CI log.

/** Run `main`, turning a thrown error into a clean non-zero exit. */
export function runMain(main) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    }
}
