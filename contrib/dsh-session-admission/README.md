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
