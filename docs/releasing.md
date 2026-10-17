# Release procedure

## Contract

`.github/workflows/release.yml` publishes the commit addressed by a pushed `v<version>` tag. The tag must exactly match `package.json.version`. Stable versions use npm `latest`; prereleases use `next` and create a GitHub prerelease. Build metadata (`+...`) is not supported.

The workflow installs the committed lockfile, runs `pnpm check`, packs once and publishes that exact tarball with **pnpm**, verifies public registry metadata, and creates a GitHub Release. Verification compares package name, version, SHA-512 tarball integrity and absence of runtime dependencies. npm's optional `gitHead` is not a verification gate: pnpm can publish successfully without that field. Publish skips lifecycle scripts because the preceding check already ran them explicitly. The normal local `prepublishOnly` check remains in place.

Authentication: repository Actions secret `NPM_TOKEN` is passed as `NODE_AUTH_TOKEN` only to the publish step. `actions/setup-node` supplies the registry auth configuration. The token needs publish rights for `opencode-magpie-plugin` and must permit unattended publishing under the npm account's current 2FA policy. GitHub Release creation uses the workflow's `GITHUB_TOKEN` with `contents: write`.

## Publish

1. Inspect `git status`, fetch the latest `main`, and check the current npm version. Preserve unrelated working changes. Choose an unused SemVer version; npm versions are immutable.
2. Update `package.json.version`. Update user-facing documentation when behavior changes; for price changes, record the changed rates and their source. Keep the package free of runtime dependencies. **Done:** the intended release diff is complete and `pnpm check` passes.
3. Commit and push the release changes to `main`. Create an annotated tag matching that version on the pushed commit, then push that tag:

   ```sh
   VERSION=$(node -p "require('./package.json').version")
   git tag -a "v$VERSION" -m "Release v$VERSION"
   git push origin "v$VERSION"
   ```

   **Done:** GitHub has a Release workflow run for that tag. A branch push alone runs CI and does not publish. Push one release tag at a time; the release concurrency group serializes publishing, but GitHub does not guarantee FIFO ordering of multiple pending runs.
4. Follow the run with `gh run watch <run-id> --exit-status`. After success, inspect the exact version with `npm view opencode-magpie-plugin@<version> version dist.integrity dependencies --json --registry=https://registry.npmjs.org/`, the appropriate dist-tag, and `gh release view v<version>`.

   **Done:** Release workflow is green; the public npm tarball matches the artifact built from the tagged commit and has no runtime dependencies; the expected npm dist-tag points to that version; the corresponding GitHub Release exists. Report both public URLs. A pushed tag or successful build alone is not a completed release.

## Recovery

- **Version mismatch:** correct the version or create a new matching tag. Keep published tags immutable.
- **Install, check or build failure:** fix the source and release a new version/tag; avoid moving an existing public tag to a different commit.
- **401 / 403 / OTP required:** replace or adjust `NPM_TOKEN` in GitHub Secrets, then rerun the failed workflow. Keep credentials out of files, logs and chat.
- **Published version already exists:** reruns skip the upload only when npm's tarball integrity equals the artifact rebuilt for the tag. Different content is a hard failure; choose a new version. A missing `gitHead` is expected and does not indicate a failed upload.
- **npm succeeded but verification or GitHub Release failed:** rerun the workflow for the same tag. It verifies the already published version and completes the missing GitHub Release. The upload is not repeated.
- **Dist-tag is wrong after an older release was pushed:** inspect registry versions before deliberately correcting it. Same-version recovery does not move npm dist-tags, so it cannot accidentally promote an older version over a newer release.

For workflow-only changes, validate the YAML and embedded commands before pushing. For a requested end-to-end release, use a new version and observe the actual tag-triggered run through the completion criteria above.
