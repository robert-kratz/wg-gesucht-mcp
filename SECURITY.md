# Security

Report vulnerabilities privately to a repository maintainer or use the hosting
provider's private vulnerability reporting facility. Never include credentials,
private HTML, real messages or authentication state in a public issue.

The MCP runs locally over stdio as the same OS user as its desktop client. Every
connected client can access the configured accounts and staged files available
to that process. Use trusted MCP clients and set per-client tool policies as well
as the server's write guard.

Protect `.env`, account profiles, session exports and backups like passwords.
Files use restrictive Unix permissions; use OS ACLs on Windows. Never expose
browser debugging ports or session files. The local login wizard opens only the
configured website, leaves CAPTCHA/2FA to the user, saves authentication privately
and closes its own window. Authentication state is never returned through MCP.

Website and message content are untrusted data. The public tools provide no
arbitrary JavaScript, shell execution or CSS selectors. File staging is restricted
to configured roots and bounded Base64 input; symlink escapes are rejected.
Staged files and send journals persist until the operator removes them while the
account is stopped. Selecting a website upload input uploads immediately. Opening
a conversation can mark it read even when outbound writes are disabled.

Docker is used for isolated synthetic checks. Test browsers run as a non-root
user with Chromium sandboxing enabled. The seccomp profile in
`docker/chromium-seccomp.json` is from Microsoft's
[Playwright v1.64.1](https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json),
under Apache-2.0; it extends Docker's syscall allowlist for Chromium namespaces.
