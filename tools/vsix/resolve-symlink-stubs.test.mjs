// Tests [DIST-VSIX-ASSET-INTEGRITY]: Git's Windows text links include skill directories.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function skillCheckout(t) {
    const root = mkdtempSync(join(tmpdir(), 'skill-link-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const canonical = join(root, '.agents', 'skills', 'fix-bug');
    const aliases = join(root, '.claude', 'skills');
    mkdirSync(canonical, { recursive: true });
    mkdirSync(aliases, { recursive: true });
    const source = join(canonical, 'SKILL.md');
    writeFileSync(source, '# Test-first skill\n');
    const alias = join(aliases, 'fix-bug');
    writeFileSync(alias, '../../.agents/skills/fix-bug');
    return { source, alias, aliases, canonical };
}

const TOOL = fileURLToPath(new URL('./resolve-symlink-stubs.mjs', import.meta.url));

test('a Windows skill stub becomes a live directory link and remains idempotent', (t) => {
    const { source, alias, aliases, canonical } = skillCheckout(t);
    for (const content of ['# Test-first skill\n', '# Updated canonical skill\n']) {
        const run = spawnSync(process.execPath, [TOOL, aliases], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        assert.ok(statSync(alias).isDirectory(), 'skill discovery needs a directory, not path text');
        writeFileSync(source, content);
        assert.equal(readFileSync(join(alias, 'SKILL.md'), 'utf8'), content, 'updates propagate without copying');
        assert.equal(realpathSync(alias), realpathSync(canonical));
    }
});

// The open refuses to follow a link, so a real symlink is never mistaken for a
// stub, even when the file it points at holds text that looks like a stub path.
test('real symlinks are left as links, never written through', { skip: process.platform === 'win32' }, (t) => {
    const { aliases, canonical } = skillCheckout(t);
    const notes = join(canonical, 'notes.txt');
    const stubLookingText = '../SKILL.md';
    writeFileSync(notes, stubLookingText);
    const fileLink = join(aliases, 'notes');
    const directoryLink = join(aliases, 'linked-skill');
    symlinkSync(notes, fileLink);
    symlinkSync(canonical, directoryLink, 'dir');

    const run = spawnSync(process.execPath, [TOOL, aliases], { encoding: 'utf8' });

    assert.equal(run.status, 0, run.stderr);
    assert.ok(lstatSync(fileLink).isSymbolicLink(), 'the file link is still a link');
    assert.ok(lstatSync(directoryLink).isSymbolicLink(), 'the directory link is still a link');
    assert.equal(readFileSync(notes, 'utf8'), stubLookingText, 'the link target was not overwritten');
    assert.doesNotMatch(run.stdout, /resolved symlink stub: .*(notes|linked-skill)/);
});
