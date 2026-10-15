# Security

Choro lets an agent control a real, logged-in browser, so security problems in it matter.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub's *Report a vulnerability* button on this
repository's Security tab, or by email to ivogeorgief@gmail.com. Include what an attacker needs (a web page, a local
program, another extension...) and what they can achieve. You'll get an answer within a week.

## The security model in brief

- The server (`choro-mcp`) and the extension authenticate each other with a pairing key: HMAC-SHA256
  challenge-response in both directions on every connection, each proof bound to the role, both nonces and the
  port. The key lives in a file only the user can read and in
  the extension's local storage; it never crosses the connection.
- The server listens on 127.0.0.1 only and refuses connections that carry a web page's origin.
- Agent sessions sharing a browser authenticate to the hub the same way, and a session can't use tabs another live
  session is working in.
- Page-world hooks are active only in tabs an agent works in. What pages report through them (dialogs, popups,
  network bodies) is treated as untrusted: it is accepted only for those tabs, rate-limited, checked where possible,
  and kept in bounded memory. Page text can't forge refs or frame markers in snapshots.

In scope: anything that lets someone without the pairing key control the browser, read what Choro sees, or make
Choro act on tabs or sites an agent didn't ask for. Out of scope: what an agent does with access it was given, and
programs already running as the same user (they can read the key, like any of the user's files).
