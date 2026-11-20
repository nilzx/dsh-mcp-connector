# Releasing

Releases are secretless: a version tag is published by GitHub Actions using
npm **trusted publishing** (OIDC). The repository stores no npm token, and each
run gets a short-lived publish token bound to this repository and this workflow.

```
tag vX.Y.Z  ->  test  ->  version check  ->  npm publish (OIDC)  ->  GitHub release
```

## One-time bootstrap

npm only accepts a trusted publisher for a package that already exists, so the
first version is published once by hand and then the trust relationship is
created. Both commands prompt for two-factor authentication.

```sh
# 1. First release only: publish the current version yourself.
npm publish --access public

# 2. Allow this repository and this workflow to publish future versions.
npm trust github @nilzx/dsh-mcp-connector \
  --file publish.yml \
  --repo nilzx/dsh-mcp-connector \
  --allow-publish
```

`--file` takes the workflow file name; npm resolves it to
`.github/workflows/publish.yml`. `--allow-publish` is required — without it the
connection is created but cannot publish.

The same relationship can be created on npmjs.com: the package's **Settings →
Trusted publishing → GitHub Actions**, with owner `nilzx`, repository
`dsh-mcp-connector`, workflow `publish.yml`.

After step 2, `NPM_TOKEN` is no longer used by any workflow and can be deleted
from the repository secrets.

## Publish a version

```sh
npm version patch   # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

The `Publish` workflow installs, tests, checks that the tag matches
`package.json`, publishes with provenance, and creates a GitHub release.

`.github/workflows/ci.yml` runs the same suite on every push to `main` and on
pull requests.

## Manual run

Actions → Publish → Run workflow publishes the current `package.json` version
without requiring a tag. The tag/version check is skipped for that path.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `EOTP` / `ERR_PNPM_OTP_NON_INTERACTIVE` | A token was used instead of trusted publishing, or the trust relationship does not exist yet. |
| `403` with `OIDC` in CI | The trusted publisher's repository, workflow file, or `--allow-publish` flag does not match this run. |
| `You cannot publish over the previously published versions` | The version in `package.json` already exists; bump it before tagging. |
