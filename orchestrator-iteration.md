Continue this project's established orchestration workflow. The current executor has finished. Optimize total cost to a verified result, not token price alone or the number of agents.

Use the applicable repository instructions and current roadmap. Inspect the actual branch, PR, diff, and checks; retrieve additional context only when relevant. Preserve unrelated changes and user work.

REVIEW AND ROUTE
Assess the latest revision against the agreed scope, acceptance criteria, and material regression risks. Reuse trustworthy verification evidence for that exact revision; run additional checks where coverage or evidence is insufficient. Do not reopen settled decisions or block completion on optional polish.

If corrections are necessary, post consolidated, actionable PR findings when a PR exists, separating merge blockers from non-blocking follow-ups. Give the executor a focused correction prompt with the findings and required validation. Resume the existing executor session when practical. After two correction rounds without material progress, change the approach, model, or task split instead of repeating the same loop. Trivial, safe fixes may be handled directly when that clearly costs less than another handoff.

If the result is acceptable, merge through the repository's normal workflow after required checks and approvals pass. Confirm that the reviewed revision is still current, respect branch protections, and verify the merge result. Update only the project state needed to reflect completion.

NEXT TASK
After a successful merge, or equivalent completion in a workflow without PRs, select the next unblocked, useful roadmap task. Prefer a coherent deliverable over artificial microtasks. Do not create extra process, documentation, refactoring, or architecture work unless the task requires it.

Choose an available executor model and supported reasoning effort based on difficulty, failure impact, and observed performance. Prefer the least expensive configuration likely to succeed; do not default to maximum effort. Use one executor unless independent work justifies additional agents and integration overhead.

Prepare a concise executor prompt covering the goal, relevant context, scope, constraints, acceptance criteria, necessary verification, and expected handoff. Specify outcomes and genuine invariants rather than micromanaging implementation. The executor should complete and validate its task, fixing in-scope failures before reporting completion.

Start the next task in a fresh session on the correct updated base, using an isolated worktree when appropriate. Configure and verify the actual model and effort; mentioning them in the prompt is not configuration. Use supported session/subagent tools, and confirm the dispatch with a real session identifier.

AUTHORITY AND STOPPING POINT
You are authorized to perform routine reviews, post relevant PR comments, dispatch corrections, run safe project checks, and merge acceptable work within the existing project policy. No repeated confirmation is needed for those actions. This does not authorize new production effects, destructive operations, spending changes, or bypassing permissions. Account for any deployment triggered by a merge.

Complete one routing cycle: dispatch the required correction, or accept the work and dispatch one next task. Do not start an unbounded roadmap loop. If access or a required decision genuinely blocks an action, report the specific blocker and complete whatever remains possible. Never claim that a comment, merge, or session launch occurred without confirmation.

Return a brief handoff: review disposition, PR/commit and verification evidence, action actually taken, next task or correction, model/effort with a short rationale, and session link/ID. Include the ready-to-run prompt and exact settings when manual dispatch is necessary.
