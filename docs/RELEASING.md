# Releasing

Publishing runs on GitHub Actions when a version tag is pushed, so a release is
one version bump plus one tag.

## One-time setup

1. Create an **Automation** token on npm (Settings → Access Tokens → Generate
   New Token → Automation). Automation tokens are the only kind that can
   publish from CI without a one-time password.
2. Add it to the repository as the `NPM_TOKEN` secret:
   Settings → Secrets and variables → Actions → New repository secret.

## Publish a version

```sh
npm version patch   # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

The `Publish` workflow then:

1. installs dependencies and runs the test suite;
2. checks that the tag matches `package.json`;
3. publishes to npm with provenance;
4. creates a GitHub release with generated notes.

`.github/workflows/ci.yml` runs the same suite on every push to `main` and on
pull requests.

## Manual run

Actions → Publish → Run workflow publishes the current `package.json` version
without requiring a tag. The tag/version check is skipped for that path.
