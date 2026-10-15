# Choro privacy policy

*Last updated: October 15, 2026. This policy covers the Choro browser extension (Chrome and Firefox) and the
choro-mcp server.*

**Choro collects no data.** It has no analytics, no telemetry and no remote servers, and its developer receives
nothing from it.

## What Choro does with the data it reads

Choro lets an AI agent that you run on your own computer use your browser. It does so only when it is paired with the
choro-mcp server on that computer: you run `choro-mcp pair` and paste the pairing key it prints into the extension's
popup.

While paired and connected, Choro reads what the agent asks for: the text and structure of pages, screenshots, the
list of open tabs (titles and addresses), and the network requests of the tabs the agent works in. It sends this over
a local connection (`ws://127.0.0.1`) to the choro-mcp server, which passes it to the agent program you run. It also
carries out the agent's actions: clicks, typing, navigation, file uploads of files the agent names.

The agent may send what it receives to its AI provider (for example Anthropic, for Claude Code), under that
provider's terms. Choro has no part in that, and which agent you connect is your choice.

## Safeguards

- Passwords, cookies, authorization headers and other secret-looking values are hidden from agents unless an agent
  explicitly asks for them.
- Network data is recorded only for tabs an agent works in, kept only in memory, and lost when the browser closes.
- The icon shows **ON** while an agent is connected, and the popup pauses agent control at any time.

## What is stored in the browser

The pairing key, the port, the on/off setting and a random id that tells the server which browser is which
(extension local storage), and which tabs each agent session uses
(session storage, cleared when the browser closes). Nothing is stored anywhere else.

## Contact

Ivo Georgief, ivogeorgief@gmail.com. Issues: https://github.com/ivogeorgief/choro/issues
