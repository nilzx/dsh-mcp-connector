# MCP connector

Bring MCP servers into DeepSeek Harness so the agent can use their tools. It connects to local commands, remote endpoints, and OAuth-protected services, and it lets you decide, tool by tool, what the agent may do.

中文: [README.zh.md](README.zh.md)

## Before you start

- DeepSeek Harness (dsh) installed.
- For a local server, the command it needs (for example `npx`) is available.

## Install

1. Open **Settings → Plugins**.
2. Choose **Add plugin** and enter `@nilzx/dsh-mcp-connector`.
3. Settings gains an **MCP connector** page.

> You can also run `dsh plugin add @nilzx/dsh-mcp-connector` in a terminal. If the page does not appear, reload the browser tab or restart the Harness.

## Add a server

Open **Settings → MCP connector** and choose **Add server**:

1. Give it a name such as `github`. The name appears in every tool name, so keep it stable.
2. Choose how to connect:
   - **Local process**: the command and, under **More connection settings**, its arguments (one per line) and environment.
   - **Remote endpoint**: the server URL, for example `https://mcp.example.com/mcp`.
3. If the server needs a key, add it under **More connection settings** (environment or headers), or store it as a credential and reference it as `${credential:NAME}`.
4. Stop typing: the configuration saves itself and reconnects. The card turns **Connected** and lists the tools it found.

The agent now sees tools named `mcp__github__<tool>`. Ask it to "use the github tools to list open issues".

## Sign in to an OAuth server

Many remote MCP servers (Linear, Notion, and similar services) use OAuth:

1. Set **Sign-in** to **OAuth**. Scopes, client ID and the rest can usually stay empty.
2. The card shows **Needs sign-in** and opens the authorization page in your browser.
3. Approve, and the card turns **Connected**.

The sign-in is stored on this machine, so a restart does not ask again. Use **Forget sign-in** to switch accounts. If no browser opens, use the **Open the sign-in page** link on the card.

## Decide what each tool may do

Open the **Tool permissions** tab. Every connected server lists its tools; choose one of:

| Permission | Effect |
|---|---|
| **Default** | Follows the server's own default. |
| **Allow** | Runs immediately. |
| **Ask** | Pauses for your approval on every call. |
| **Block** | Refused without running. |
| **Hide** | Not offered to the agent at all. |

The server header sets the default for everything not listed. **Pattern rules** (for example `delete_*`) cover tools the server has not listed yet; they run in order and the first match wins.

Changes save automatically. These rules govern the agent's calls, not the server.

## Choose where a server applies

Each server has **Where it applies**:

- **Everywhere (global)** — the default; the tools are available in every session.
- **Only in selected workspaces** — the tools appear only in sessions that run in one of the directories you pick.

This is useful for project-specific servers: keep a work server out of personal sessions, or connect two accounts of the same service to different projects.

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

**The agent cannot see a tool.** Check the server is **Connected** and the tool is neither **Hide** nor **Block**. A new session reloads the tool list.

**A change did not apply.** Saving is automatic; if the status says it failed, choose **Reload** and try again. As a last resort disable and re-enable the plugin.

**Sign-in keeps failing.** Use **Forget sign-in**, then **Sign in** again for a fresh link.

## Privacy and safety

- Tool arguments go to the server you configured, and results return to the conversation. Only connect servers you trust.
- For tools that change remote data, use **Ask** or **Block**.
- Sign-ins are stored locally and never written into configuration files.

## Feedback

- Issues: <https://github.com/nilzx/dsh-mcp-connector/issues>

## License

MIT