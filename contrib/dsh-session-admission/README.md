# Proposed host session admission contract

This optional, generic host capability is a source proposal for DeepSeek Harness 0.2.2-rc.5, compared with upstream master `2e39e70496aa02986ca6a820c5d497e816b69d7e`. It contains no Ziwo tool names or data formats. It has **not** been installed into the user's dsh distribution and is not applied by this connector.

## Contract

- `sessions.preparationAdmissionVersion === 1` advertises a synchronous, scoped `session/preparing` event.
- The event runs before `Session.create` or `Session.fromRestore` consumes the captured seed, and before the prepared destination can be handed to a persistence owner.
- Listeners receive a frozen header, seed presence/count, inherited count, and restoration flag. They never receive seed content. Throwing vetoes creation. Returning a promise is rejected synchronously; another listener cannot override a refusal.
- Creation and restoration use the same captured metadata after admission. Normal SessionStore and API forks include their actual `parentSession`.
- No registered listener preserves normal host behavior. The connector can require this capability explicitly, without reinterpreting older hosts as compliant.

The host can read source history and build an intermediate seed before this event. This is a destination construction/persistence boundary, not a prohibition on source reads. Privileged plugins that directly construct sessions or write persistence outside SessionStore remain outside the contract. Trusted host metadata and intact ownership storage are prerequisites.

## Review and validation

`host.patch` targets the upstream source layout. Apply only to a reviewed checkout, build with that project's supported toolchain, and run its checks. Do not apply it directly to a global installed package or assume an upstream release contains it.

Local isolated tests used the real Cordis Context and compiled SessionStore: denial before seed element access and caller persistence (including restore), frozen metadata, promise rejection, persistent fork parent metadata, and scope routing. Connector tests additionally cover unsupported-host startup refusal, source-less seeds, protected parents across scope changes, and restored ownership. These are boundary checks, not a claim that the entire dsh UI/API matrix has passed.

The source context is from the MIT-licensed [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness).


## Reproducible isolated build

The connector declares Node >=20. This optional builder emits modules targeting Node 22; use Node 22 or newer for the isolated host build and runtime. The isolated package and host build checks passed on Node 22.23.5 and Node 26.13.1; other versions have not been independently verified. The builder requires Git, an installed dsh 0.2.2-rc.5, and esbuild 0.28.2. It verifies the two reviewed source hashes, refuses existing output directories and paths inside the installed dsh, copies sources into a new output directory, applies the patch there, and emits both modules plus a hash manifest. It never edits the installed distribution or user profiles.

```sh
node /absolute/path/to/node_modules/@nilzx/dsh-mcp-connector/contrib/dsh-session-admission/build.mjs "/absolute/path/to/@deepseek-ai/dsh" "/absolute/path/to/new-build" "/absolute/path/to/esbuild/lib/main.js"
```

Use the output only in a separate test profile based on the full dsh Web app bundles. In that profile's patch, disable the original services and insert the built modules; `name` on an existing patch entry is a match condition, not a module replacement:

```yaml
- id: session
  disabled: true
- id: session-controller
  disabled: true
- insert:
    - id: admitted-sessions
      name: /absolute/path/to/new-build/session/index.js
    - id: admitted-session-controller
      name: /absolute/path/to/new-build/api-session-controller/index.js
```

On each protected connector workflow set `lifecycle.requireCreationAdmission: true`. Keep an isolated `DSH_HOME` and the existing scope, endpoint, credentials and ownership stores for any conversation being restored. Never invent parent metadata or discard sidecars to work around a refusal. A headless-only profile needs only the Session service, but cannot necessarily resume the `standard` preset produced by the Web fork API; use the full host for those forks.

The builder fails with an explicit version or source-hash error if the host or esbuild does not match the reviewed inputs; an existing output directory is also rejected. Obtain matching dependencies separately and do not bypass these checks.

The following tests are available in a source checkout (the npm package does not include the test suite). The real-module connector test accepts `DSH_CORDIS_MODULE` pointing to the installed Cordis module and `DSH_SESSION_ADMISSION_MODULE` pointing to the newly built Session module:

```sh
node --test test/creation-admission.test.js test/real-session-admission.test.js
```

Set those environment variables before the command; without them the real-module test is explicitly skipped. The final local validation additionally exercised the full host's ordinary fork API, persisted 219 inherited events with their actual parent, resumed that child through the full host, loaded the original subject's current persona, and independently refreshed its memory. It did not simulate a browser click, install the patch globally, or establish upstream support.

From a source checkout, `npm run test:package -- /absolute/path/to/@deepseek-ai/dsh /absolute/path/to/esbuild/lib/main.js` packs and installs the connector in a temporary directory, verifies the bundled materials, and builds the host modules there. Omit both paths to run the package checks without the host build. The check downloads package dependencies as needed and removes its temporary directory afterward.
