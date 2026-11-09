# Releasing dsh-litnotes

Two GitHub Actions workflows own the release path; both live in
[`.github/workflows`](../.github/workflows).

| workflow | trigger | what it does |
| --- | --- | --- |
| [`ci.yml`](../.github/workflows/ci.yml) | push to `main`, pull requests | runs the release gate on Node 22 and 24, checks that the committed build artifacts are current and that the npm tarball carries every runtime file, and loads the published host entry on the oldest supported Node (20.16) |
| [`publish-npm.yml`](../.github/workflows/publish-npm.yml) | a **published** GitHub Release, or a manual dispatch | re-runs the gate on the tagged commit, packs and verifies the tarball, publishes to npm, attaches `dsh-litnotes-<version>.tgz` to the release, and uploads the tarball as a workflow artifact |

## One-time setup: npm authentication

The recommended path is npm **trusted publishing** (OIDC), which needs no
long-lived secret and produces a provenance statement on every publish.

1. Sign in to [npmjs.com](https://www.npmjs.com/) and open the package:
   **`dsh-litnotes` → Settings → Trusted publishing**.
2. Add a GitHub Actions trusted publisher with exactly these fields:
   - Organization or user: `NIRVANA-APOC`
   - Repository: `dsh-litnotes`
   - Workflow filename: `publish-npm.yml` (filename only; the `.yml` suffix is required)
   - Environment name: leave empty (the workflow does not use a GitHub environment)
   - Allowed actions: allow `npm publish` (the workflow publishes directly)
3. Save. npm does not validate the fields when saving — a mismatch only shows up
   as `ENEEDAUTH` on the first publish. A new configuration must complete its
   first successful publish within two days of being created, so add it right
   before a release.
4. After the first successful OIDC publish, consider **Settings → Publishing
   access → "Require two-factor authentication and disallow tokens"** to remove
   token-based publishing entirely.

The same connection can be created from a logged-in npm CLI (npm 11.5.1+):

```bash
npm login
npm trust github dsh-litnotes --file publish-npm.yml --repo NIRVANA-APOC/dsh-litnotes --allow-publish -y
npm trust list dsh-litnotes   # verify the connection
```

The package already exists on npm (that is a prerequisite for configuring a
trusted publisher), and its `repository.url` in `package.json` already matches
this GitHub repository, which provenance generation requires.

### Fallback: NPM_TOKEN

If trusted publishing is not an option, add a repository secret named
`NPM_TOKEN` (**Settings → Secrets and variables → Actions**) containing a
granular access token with publish permission for `dsh-litnotes`. The workflow
detects the secret, writes the registry token for that step only and publishes
with `--provenance`. When both are configured the token wins; delete the secret
to go back to OIDC.

## Release checklist

1. Bump `version` in `package.json` and add the matching `CHANGELOG.md` section.
2. Rebuild the committed artifacts with `node scripts/build.ts` and commit them
   (the CI gate fails when `index.js` or `lib/client.js` is stale).
3. Run the release gate locally: `node scripts/check.ts --final`.
4. Commit and push `main`.
5. Tag the exact release commit and push the tag:

   ```bash
   git tag v<version>        # e.g. v1.1.0
   git push origin v<version>
   ```

6. Create the release: GitHub → **Releases → Draft a new release**, choose the
   tag, write the notes and press **Publish release**. Draft releases do not
   trigger the workflow — only the `published` event does.
7. Watch **Actions → Publish to npm**. The job:
   - verifies the tag equals `v` + `package.json` version,
   - verifies the version is not already on npm,
   - runs `node scripts/check.ts` on the tagged commit,
   - packs the package and checks the tarball contract (`scripts/pack-check.ts`),
   - publishes to npm (OIDC by default, `NPM_TOKEN` when configured),
   - attaches `dsh-litnotes-<version>.tgz` to the release and uploads it as the
     `npm-package` workflow artifact.
8. Verify the result: `npm view dsh-litnotes@<version>`, the npm package page
   (provenance badge), and the release asset URL documented in the README.

## Dry runs

Manual runs are dry runs unless `dry_run` is unchecked:

- Actions → **Publish to npm → Run workflow** (leave *dry_run* checked). The job
  runs the gate, packs the tarball, checks the registry and prints the
  `npm publish --dry-run` plan without writing anything. The `dist_tag` input
  selects the npm dist-tag for a manual publish (default `latest`).
- From the CLI: `gh workflow run publish-npm.yml --ref main`.
- Locally, `node scripts/pack-check.ts` packs the package and validates the
  contents; the last output line is `TARBALL=<path>`.

To publish a tag manually (for example to retry a failed release job), choose
the tag in **Use workflow from**, uncheck *dry_run*, and run the workflow.

## Behaviour worth knowing

- **Every version is published under the `latest` dist-tag by default.** npm
  requires an explicit `--tag` for prerelease versions (it refuses to guess), and
  `latest` keeps the install path in README.md pointing at the current line (both
  `1.1.0-alpha` releases are published under `latest`). To keep a separate
  prerelease channel, run the workflow manually with `dist_tag: next` (or edit
  the default) and later publish the stable release with `latest`.
- **Re-runs are safe.** The workflow skips the publish steps when
  `dsh-litnotes@<version>` already exists on npm; npm versions are immutable, so
  a corrected build needs a new version.
- **Only tags that contain this workflow work.** The publish job runs against
  the tagged commit, so tags created before these files existed cannot use it.
- The `npm warn Unknown project config ...` lines come from the pnpm-only keys
  in `.npmrc`; they are harmless for `npm publish`.

## Troubleshooting

| symptom | cause |
| --- | --- |
| `ENEEDAUTH` / "Unable to authenticate" | trusted publisher fields do not match, the workflow is not `publish-npm.yml`, the job lost `id-token: write`, or the runner is not GitHub-hosted |
| "tag vX does not match package.json version vY" | the tag and the tagged commit's `package.json` disagree — move the tag or fix the version |
| "cannot publish over previously published version" | the version is already on npm; bump the version |
| no provenance on the npm page | the repository is private, `repository.url` does not match, or the publish used a path without OIDC/provenance |
| stale artifact error | `index.js` / `lib/client.js` in the tagged commit were not rebuilt with `node scripts/build.ts` |
