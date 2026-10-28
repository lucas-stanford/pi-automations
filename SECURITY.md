# Security policy

pi-automations runs agent sessions and scripts on a schedule, with the permissions of the person who
installed it, so a security bug acts with those permissions too.

## Reporting a vulnerability

Please **do not** open a public issue. Report privately instead:

- through GitHub's private vulnerability reporting ("Report a vulnerability" on the repository's
  Security tab), or
- by email to TODO: security contact address.

Include what you found, how to reproduce it, and the impact you expect. You should get an
acknowledgement within a week. Please give us a reasonable time to release a fix before disclosing.

## Supported versions

Only the latest release receives security fixes.

## Scope

Of particular interest:

- an automation, in a repository or in the home directory, that runs anything without the
  person's explicit consent, or keeps running after its files change;
- a plugin being loaded from anywhere other than the person's own `config.json`;
- credentials reaching a hook, a watch script, the watcher's job file or a run record;
- text written by an automation or an agent reaching the terminal as an escape sequence;
- the Automation Manager's local server being reachable from other origins or hosts.
