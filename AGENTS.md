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

## Task completion

At the end of every task, report:

1. Files changed.
2. Tests and checks run, with exact results.
3. Assumptions and unresolved risks.
4. Whether any production or external action remains.
5. A focused diff ready for human review.

Do not merge or deploy automatically.