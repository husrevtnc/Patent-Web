# Security policy

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues. Use GitHub's private vulnerability reporting for this repository when it is enabled. If private reporting is unavailable, contact the repository owner through their GitHub profile and include only the information needed to reproduce the issue.

Do not include API keys, access tokens, private search ideas, or personal data in reports. Revoke and rotate any credential that may have been exposed.

## Deployment notes

The development server binds to `127.0.0.1` by default and has no user authentication. Keep it on a trusted local machine; do not expose it to a public network without adding authentication, access controls, and an appropriate deployment review.

When using a cloud LLM, search ideas are sent to the selected provider to produce the verdict. Keep API credentials in the server environment and out of the browser, source files, logs, and Git history.
