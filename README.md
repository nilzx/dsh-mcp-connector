# MCP connector

Bring MCP servers into DeepSeek Harness so the agent can use their tools. It connects to local commands, remote endpoints, and OAuth-protected services, and it lets you decide, tool by tool, what the agent may do.

中文: [README.zh.md](README.zh.md)

## Before you start

- DeepSeek Harness (dsh) installed.
- For a local server, the command it needs (for example `npx`) is available.

## Preview and compatibility

The `0.3.0-rc.1` candidate is a preview; after publication it is selected with `@next`. Ordinary MCP connections do not require a capability profile. The optional trusted lifecycle profile requires host admission version 1; stock dsh 0.2.2-rc.5 does not provide it. See [preview migration and rollback](docs/PREVIEW.md) and [host contract](docs/HOST-CONTRACT-v1.md). A configured profile is not certification.

## Install

1. Open **Settings → Plugins**.
2. Choose **Add plugin** and enter `@nilzx/dsh-mcp-connector@0.3.0-rc.1`.
3. Settings gains an **MCP connector** page.

> You can also run `dsh plugin add @nilzx/dsh-mcp-connector@0.3.0-rc.1` in a terminal. If the page does not appear, reload the browser tab or restart the Harness.

## Add a server

Open **Settings → MCP connector** and choose **Add server**:

1. Give it a name such as `github`. The name appears in every tool name, so keep it stable.
2. Choose how to connect:
   - **Local process**: the command and, under **More connection settings**, its arguments (one per line) and environment.
   - **Remote endpoint**: the server URL, for example `https://mcp.example.com/mcp`.
3. If the server needs a key, add it under **More connection settings** (environment or headers), or store it as a credential and reference it as `${credential:NAME}`.
4. Press **Enter** or leave the field: the configuration saves and reconnects. The card turns **Connected** and lists the tools it found.

The agent now sees tools named `mcp__github__<tool>`. Ask it to "use the github tools to list open issues".

## Inside a server card

Expanding a server shows three sub-tabs:

- **Connection** (opens first) — name, connection, sign-in, and the optional connection settings.
- **Permissions** — the default permission and one row per discovered tool.
- **Other** — where the server applies, and whether temporary agents may use it.

## Sign in to an OAuth server

Many remote MCP servers (Linear, Notion, and similar services) use OAuth:

1. In **Connection**, set **Sign-in** to **OAuth**. Optional fields such as scopes, client ID, and callback port sit under **OAuth options** and can usually stay empty.
2. The card shows **Needs sign-in** and opens the authorization page in your browser.
3. Approve, and the card turns **Connected**.

The sign-in is stored on this machine, so a restart does not ask again. Use **Forget sign-in** to switch accounts. If no browser opens, use the **Open the sign-in page** link on the card.

## Decide what each tool may do

Open a server's **Permissions** sub-tab. Every connected server lists its tools; choose one of:

| Permission | Effect |
|---|---|
| **Default** | Follows the server's own default. |
| **Allow** | Runs immediately. |
| **Ask** | Pauses for your approval on every call. |
| **Block** | Refused without running. |
| **Hide** | Not offered to the agent at all. |

The first row sets the default for everything not listed. **Pattern rules** (for example `delete_*`) cover tools the server has not listed yet; they run in order and the first match wins.

These rules govern the agent's calls, not the server.

## Choose where a server applies

Open a server's **Other** sub-tab:

- **Everywhere (global)** — the default; the tools are available in every session.
- **Only in selected workspaces** — the tools appear only in sessions that run in one of the directories you pick.

This is useful for project-specific servers: keep a work server out of personal sessions, or connect two accounts of the same service to different projects.

**Temporary agents** lives here too. Set it to **Block access** for servers that belong only to the primary conversation — for example a personal memory service. Subagents then cannot see or call that server, while a fork of the primary conversation stays eligible.

For YAML-only options such as context refresh, trusted session metadata, and initialization workflows, see [Advanced configuration](docs/ADVANCED.md). Those are unreleased and not exposed in the panel.

## When changes are saved

- Checkboxes and menus save as soon as you change them.
- Text fields save when you press **Enter** or leave the field, so a half-typed URL is never submitted.
- Deleting a server, a rule, or a row saves immediately.
- Adding an empty server, rule, or row is not saved until you fill it in.

The header shows whether the configuration is saved, being saved, has unsaved changes, or is incomplete. An incomplete configuration is never written.

## Connection states

| State | Meaning |
|---|---|
| Connected | Tools are available. |
| Connecting / Reconnecting | An attempt is in flight. |
| Needs sign-in | Waiting for you to finish in the browser. |
| Failed | Retries were exhausted; fix the cause and choose **Reconnect**. |
| Disabled | Configuration kept, connection off. |

## Troubleshooting

**It will not connect.** Expand the card and read the last error. For a local server the usual cause is a wrong command or a missing dependency; for a remote endpoint it is a wrong URL, a network problem, or a sign-in requirement. Fix it and choose **Reconnect**.

**The URL has no path.** Many services serve MCP at a path such as `/mcp` or `/ds/mcp`; the bare domain usually answers 404 and never asks for a sign-in. Copy the exact endpoint from the service.

**The agent cannot see a tool.** Check the server is **Connected** and, under **Permissions**, the tool is neither **Hide** nor **Block**. A new session reloads the tool list.

**A change did not apply.** Finish the field with **Enter**, or leave it; checkboxes and menus save themselves. If the header stays on a failure, choose **Reload** and try again. As a last resort disable and re-enable the plugin.

**Sign-in keeps failing.** Use **Forget sign-in**, then **Sign in** again for a fresh link.

## Privacy and safety

- Tool arguments go to the server you configured, and results return to the conversation. Only connect servers you trust.
- For tools that change remote data, use **Ask** or **Block**.
- Sign-ins are stored locally and never written into configuration files.

## Feedback

- Issues: <https://github.com/nilzx/dsh-mcp-connector/issues>

## License

MIT