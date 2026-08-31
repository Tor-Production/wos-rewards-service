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

- Every task is completed in a separate branch and a separate pull request.
- Every new task starts from the latest `main`.
- A dependent task must not start until the previous pull request has been merged.
- Review fixes must be made in the same branch and pull request as the task under review.
- The agent must not merge or deploy automatically.
- Tokens, credentials, cookies, API keys, Discord tokens, Cloudflare credentials, and session secrets must never be committed, printed, logged, or requested.

## Player registration contract

Supported Discord message forms:

- `PLAYER_ID`
- `PLAYER_ID DISPLAY_NAME`
- `PLAYER_ID STATE`
- `PLAYER_ID STATE DISPLAY_NAME`

Parsing and behavior:

- `PLAYER_ID` is required and must be numeric.
- If the second parameter is numeric, treat it as `STATE`.
- If the second parameter is not numeric, use the configured `DEFAULT_STATE` and treat the second and all remaining parameters as `DISPLAY_NAME`.
- `DISPLAY_NAME` is optional and may contain spaces.
- If no display name is supplied, Discord output must use `ID <PLAYER_ID>`.
- Re-registering an existing player updates the existing record instead of creating a duplicate.
- Sanitize display names and disable unintended Discord mentions.
- `DEFAULT_STATE` must come from environment configuration, not a hard-coded value.
- Do not attempt to discover the player's state or nickname from an undocumented Whiteout Survival endpoint.

Runtime Discord footer requirement:

- Append this footer, exactly once, to final runtime Discord operation summaries produced after gift-code processing (rendered verbatim, without smart quotes):

  ```
  ℹ️ To add yourself to automatic reward distribution, send the following in #wos-registration: PLAYER_ID [STATE] [NAME]. If STATE is omitted, the configured default state is used. Name is optional.
  ```

- The footer applies only to final runtime Discord operation summaries emitted by the deployed service after gift-code processing. It must never be appended to agent replies, logs, documentation explanations, commit messages, or pull request descriptions.

## Task completion

At the end of every task, report:

1. Files changed.
2. Tests and checks run, with exact results.
3. Assumptions and unresolved risks.
4. Whether any production or external action remains.
5. A focused diff ready for human review.

Do not merge or deploy automatically.

## Documentation routing

- Start from `docs/README.md` for current state and a routing table into the architecture docs.
- `docs/architecture.md` is the overview; detailed material lives in focused documents under `docs/architecture/`.
- Load only the documents relevant to the task at hand.
