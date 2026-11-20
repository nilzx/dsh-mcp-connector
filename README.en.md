# MCP connector

Bring MCP servers into DeepSeek Harness so the agent can use their tools. It
connects to local commands, remote endpoints, and OAuth-protected services, and
it lets you decide, tool by tool, what the agent may do.

中文: [README.md](README.md)

## Before you start

- DeepSeek Harness (dsh) installed.
- For a local server, the command it needs (for example `npx`) is available.

## Install

1. Open **Settings → Plugins**.
2. Add a plugin and enter the package name `@nilzx/dsh-mcp-connector`.
3. When it is installed, Settings gains an **MCP connector** page.

> You can also run `dsh plugin add @nilzx/dsh-mcp-connector` in a terminal. If
> the page does not appear, reload the browser tab or restart the Harness.

## Add your first server

Open **Settings → MCP connector** and choose **Add server**:

1. Give it a name such as `github`. The name appears in every tool name, so keep
   it stable.
2. Choose how to connect:
   - **Local process**: enter the command and arguments, for example command
     `npx` with one argument per line:
     ```
     -y
     @modelcontextprotocol/server-github
     ```
   - **Remote endpoint**: enter the server URL, for example
     `https://mcp.example.com/mcp`.
3. If the server needs a secret, put it under **Environment** (local) or
   **Headers** (remote). Prefer storing it as a credential and referencing it as
   `${credential:NAME}` so no plain-text secret ends up in configuration.
4. Choose **Save**. The connector reconnects and the card shows **Connected**
   with the tools it discovered.

The agent now sees tools named `mcp__github__<tool>`. Ask it to "use the github
tools to list open issues" and it will.

## Sign in to an OAuth server

Many remote MCP servers (Linear, Notion, and similar services) use OAuth:

1. When adding the server, set **Sign-in** to **OAuth**. Leave scopes, client ID
   and the rest empty unless the service told you otherwise.
2. After saving, the card shows **Needs sign-in**.
3. Choose **Sign in**. Your browser opens the authorization page; after you
   approve, the card turns **Connected**.
4. The sign-in is stored on this machine, so next time no browser is needed. Use
   **Forget sign-in** to switch accounts.

If no browser opens, use the **Open the sign-in page** link on the card. The
page itself is handled by the service you are signing in to; Harness only keeps
the result.

## Decide what each tool may do

Every server card has **Tool permissions**. Rules are matched from top to bottom
and the first match wins; `*` matches any characters.

| Permission | Effect |
|---|---|
| **Allow** | Runs immediately. |
| **Ask** | Pauses for your approval on every call. |
| **Block** | Refused without running. |
| **Hide** | Not offered to the agent at all. |

For example, read-only access with confirmation for changes and no deletes:

```
Everything else: Block
list_*           Allow
get_*            Allow
create_*         Ask
delete_*         Block
```

Save when you are done. These rules govern the agent's calls, not the server.

## Connection states

| State | Meaning |
|---|---|
| Connected | Tools are available. |
| Connecting / Reconnecting | An attempt is in flight. |
| Needs sign-in | Waiting for you to finish in the browser. |
| Failed | Retries were exhausted; fix the cause and choose **Reconnect**. |
| Disabled | Configuration kept, connection off. |

The list refreshes every 8 seconds; **Refresh** updates it immediately.

## Troubleshooting

**It will not connect.** Expand the card to read the last error. For a local
server the usual cause is a wrong command or a missing dependency; for a remote
endpoint it is a wrong URL, a network problem, or a sign-in requirement. Fix it
and choose **Reconnect**.

**A change did not apply.** Saving reconnects automatically. If the status looks
stale, choose **Refresh**; as a last resort disable and re-enable the plugin.

**The agent cannot see a tool.** Check the card is **Connected** and the tool is
neither **Hide** nor **Block**. A new session is the quickest way to reload the
tool list.

**No sign-in page opens.** Use the **Open the sign-in page** link on the card,
finish in the browser, then return to Harness.

**Removing it.** Uninstall the plugin from **Settings → Plugins**. Stored
sign-ins stay on the machine; clear them with **Forget sign-in** first if you
want them gone.

## Privacy and safety

- Tool arguments go to the server you configured, and results return to the
  conversation. Only connect servers you trust.
- For tools that change remote data, use **Ask** or **Block**.
- Sign-ins are stored locally and never written into configuration files.

## Feedback

- Issues: <https://github.com/nilzx/dsh-mcp-connector/issues>

## License

MIT