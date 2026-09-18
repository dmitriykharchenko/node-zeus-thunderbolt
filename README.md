# node-zeus-thunderbolt

`nzt` recursively prunes eligible `node_modules` directories beneath a supplied
directory. It has no external dependencies and requires **Node.js >=23.6.0**
(newer versions are supported; no exact version is required).

## Install from a local package

This project is prepared for npm distribution but is not published by this
workflow. Registry availability of the name is not guaranteed. From a checkout,
run `npm pack`, then `npm install --global ./node-zeus-thunderbolt-0.1.0.tgz`.
Packing builds the JavaScript automatically; installation needs no build tools.
Run `nzt --version` or `nzt --help` to check the installed command.

Alternatively, install the tarball into a project with
`npm install --save-dev /absolute/path/to/node-zeus-thunderbolt-0.1.0.tgz` and
invoke `./node_modules/.bin/nzt` (or `node_modules\.bin\nzt.cmd` on Windows).

## Usage

- Preview first: `nzt --dry-run /path/to/projects`
- Remove eligible directories: `nzt /path/to/projects`
- Preview **all** candidates, including unmarked ones:
  `nzt --smite --dry-run /path/to/projects`
- Remove all candidates: `nzt --smite /path/to/projects`
- Show paths, sizes, and skip reasons: `nzt --verbose --dry-run /path/to/projects`
- Quote paths containing spaces: `nzt --dry-run "./my projects"`.
- Use `--` for paths starting with a dash: `nzt --dry-run -- -project`.

Exactly one directory is required. Relative paths are resolved from your current
working directory. Projects can be nested arbitrarily deeply. An explicitly
supplied `node_modules` directory is itself a candidate.

### Eligibility

By default a real directory named exactly `node_modules` is removed only if its
**immediate parent** contains a regular `package.json` file and at least one of:

- `package-lock.json` or `npm-shrinkwrap.json` (npm)
- `yarn.lock` (Yarn)
- `pnpm-lock.yaml` (pnpm)
- `bun.lock` or `bun.lockb` (Bun)

File contents are not parsed. Directories or symlinks with these marker names do
not count. Markers in an ancestor workspace do not qualify a nested candidate.
Unmarked candidates are skipped and their contents are never read. Eligible
dependency trees are traversed only to measure size, never to discover more
projects. Nested dependencies are included in their containing candidate's size.

### Progress and size estimates

By default stdout shows only running aggregate counters, for example:
`Estimated freed: 1.50 MiB | 3 removed | 2 require --smite`.
With `--dry-run` it reports estimated bytes that **would** be freed and the number
of planned directories instead. Updates appear as candidates are processed, with
a final state even when nothing matches. Compact interactive terminals refresh
one line with a small Braille spinner every 80 ms, starting at zero and staying
active while scanning and measuring. The final line is static, without a spinner.
Verbose output never animates. Pipes and redirected output receive plain
newline-delimited updates, without a spinner, terminal escapes, or carriage returns.

The `require --smite` count means **additional** real `node_modules` directories
skipped only because their immediate parent lacks regular manifest/lockfile
markers. It excludes symlinks, unsafe paths, and filesystem errors, and is zero
when `--smite` is active because those candidates already count as removed/planned.

Use `--verbose` with any pruning mode for each candidate's full path and size,
skip reasons, aggregate totals, and deleted/planned/skipped/error counts. Errors
always appear on stderr, whether or not verbose output is enabled.

Sizes use B/KiB/MiB/GiB/TiB and sum **logical regular-file sizes**, not physical
disk free-space deltas. Symlinks are never followed or counted; directory sizes
and other non-regular files are excluded. Each hardlink pathname is counted, so
hardlinked dependencies (including pnpm stores), sparse/compressed/shared files,
and filesystem metadata can make actual reclaimed space differ substantially.
Measurement adds a file-metadata scan before every eligible removal, including
dry-runs; file contents are not read. A measurement failure leaves that candidate
untouched. Only fully successful removals contribute freed bytes: a partially
failed removal may free some space but contributes no bytes or removed directory
to the counters. Skipped and failed candidates never inflate byte totals.

### Safety and errors

**Deletion is permanent, not a move to the trash.** The default command deletes;
`--dry-run` only reports planned removals and makes no changes. **`--smite` bypasses
both manifest and lockfile requirements**, but retains path and symlink safeguards.
It can remove unmarked dependency trees; always preview and check the target.

Directory symlinks encountered during traversal and symlink candidates are
skipped; a symlink supplied as the starting path is rejected. Ancestor aliases
(such as macOS `/tmp`) are canonicalized. Filesystem roots and starting paths
inside a `node_modules` tree are rejected. Unrelated files and directories are
left intact.

Use a stable directory tree: do not concurrently install dependencies, rename
directories, or otherwise mutate the scan target. Identity/path checks reduce
race risks, but cannot make recursive deletion atomic against adversarial
concurrent filesystem changes. Also keep the installed tool outside the tree
you intend to prune, so you do not delete its own installation.

Candidates and their ancestors are revalidated after measurement and before
deletion. Errors do not stop accessible sibling projects from being processed.
Exit status is `0` for a successful scan (including no matches), `1` for filesystem
or unsafe-path errors, and `2` for invalid arguments. Help/version exit `0`.

## Development and packaging

No dependency installation is needed to build or test. With Node.js >=23.6.0:

- Native TypeScript CLI: `node src/cli.ts --dry-run /path/to/projects`
  (also `npm start -- --dry-run /path/to/projects`)
- Full suite: `npm test`
- Packed-install smoke test only: `npm run test:distribution`
- Generate JavaScript: `npm run build`
- Inspect package contents without creating a tarball: `npm pack --dry-run`
- Build and create a tarball: `npm pack`

The `.nvmrc` selects the optional 23.6.0 lower-bound test runtime, not a required
exact development version. Source and tests use Node's native TypeScript support.
Node does not strip TypeScript inside installed `node_modules`, so the package
ships generated JavaScript instead. The dependency-free build uses Node's built-in
`stripTypeScriptTypes`, rewrites relative `.ts` imports to `.js`, preserves the
shebang and package metadata lookup, and marks the CLI executable. Node may emit
an experimental-feature warning while building on supported releases.

Only `dist/cli.js`, `dist/prune.js`, `dist/output.js`, `package.json`, and this README are packed.
TypeScript sources, tests, build scripts, and fixtures are excluded. The `prepack`
hook builds only: it does not run tests, avoiding recursive test/pack invocation.
There are no install-time build hooks; tarball consumers need only Node and npm.
The distribution test packs a fresh disposable source copy, checks the allowlist,
installs the tarball into temporary `node_modules` with lifecycle scripts enabled,
then executes the installed `nzt` in normal, `--smite`, `--dry-run`, and `--verbose` modes.
Tests prune only disposable fixtures, never your real projects. Nothing in this
workflow publishes to npm.
