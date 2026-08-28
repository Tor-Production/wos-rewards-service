# AGENTS.md

## Product

This repository contains a Cloudflare-hosted Discord service for registering Whiteout Survival players and processing gift codes.

## Safety boundaries

- Staging is the default environment.
- Never deploy to production, create production resources, rotate secrets, or perform a real gift-code redemption without explicit human approval.
- Never commit, print, log, or request Discord tokens, API keys, cookies, user tokens, session credentials, or Cloudflare credentials.
- Do not implement Discord self-bots or automate a normal Discord user account.
- Do not bypass CAPTCHAs, anti-bot protections, rate limits, authentication, or access controls.
- Do not reverse-engineer or call undocumented Whiteout Survival endpoints unless a human has recorded explicit authorization and the API contract in docs/whiteout-provider-decision.md.
- All Whiteout Survival access must go through the WhiteoutProvider interface.
- MockWhiteoutProvider is the default in development, tests, and staging.
- If no authorized production provider exists, keep production redemption disabled and report the blocker clearly.

## Engineering requirements

- Use TypeScript strict mode and APIs compatible with the Cloudflare Workers runtime.
- Keep staging and production D1 databases, queues, Durable Objects, Discord applications, and secrets separate.
- Every Discord event and every player/code redemption must be idempotent.
- Use D1 migrations; do not perform destructive schema changes without explicit approval.
- Use Cloudflare Queues for redemption work and configure a dead-letter queue.
- Sanitize Discord output and disable unintended mentions.
- Do not silently delete or modify Discord messages.
- Include unit tests for validation, deduplication, retry classification, message chunking, and provider error mapping.
- Run formatting, type checking, unit tests, and available integration tests before finishing.

## Branch and task workflow

- Each task must be completed in a separate branch and a separate pull request.
- Every new task must start from the latest `main`.
- Do not start a dependent task until the previous pull request has been merged.
- Review fixes must be made in the same branch and pull request as the task being reviewed.
- Do not deploy code or modify external Discord or Cloudflare resources unless a separate task explicitly requests it.
- Never add tokens, API keys, passwords, cookies, session credentials, or other secrets to the repository.

## Player registration contract

Supported Discord message formats:

- `PLAYER_ID`
- `PLAYER_ID DISPLAY_NAME`
- `PLAYER_ID STATE DISPLAY_NAME`

Parsing and behavior:

- `PLAYER_ID` is required and must be numeric.
- If the second parameter is numeric, treat it as `STATE`.
- If the second parameter is non-numeric, use `DEFAULT_STATE` as the State and treat the second and all subsequent parameters as `DISPLAY_NAME`.
- `DISPLAY_NAME` is optional and may contain spaces.
- If no Display Name is provided, show `ID <PLAYER_ID>` in Discord messages.
- Re-registering an existing Player ID must update the existing record rather than create a duplicate.
- Sanitize Display Name by removing Discord mentions and unsafe Discord formatting.
- `DEFAULT_STATE` must come from environment configuration and must not be hardcoded.

Runtime Discord footer requirement:

- After every final Discord operation summary about gift-code application, append this footer exactly once:
  “ℹ️ To add yourself to automatic reward distribution, send the following in #wos-registration: PLAYER_ID [STATE] [NAME]. If STATE is omitted, the configured default state is used. Name is optional.”
- This footer applies only to runtime Discord messages emitted by the deployed service after a gift-code operation. Never append it to Jules responses, task summaries, logs, documentation reports, commit messages, or pull-request descriptions.

## Task completion

At the end of every task, report:

1. Files changed.
2. Tests and checks run, with exact results.
3. Assumptions and unresolved risks.
4. Whether any production or external action remains.
5. A focused diff ready for human review.

Do not merge or deploy automatically.
