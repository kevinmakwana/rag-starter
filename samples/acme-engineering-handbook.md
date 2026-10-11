# Acme Engineering Handbook

This is a fictional handbook used as sample data for the RAG starter.

## Working hours

The engineering team works remotely across three time zones. Core collaboration hours are 14:00 to 18:00 UTC, and everyone is expected to be reachable during that window. Outside core hours, people plan their own day.

## Code review

Every pull request needs one approving review before it can be merged. Reviews should happen within one business day. Authors keep pull requests under 400 changed lines where possible, and split larger changes behind a feature flag.

Reviewers focus on correctness, security and readability, in that order. Style issues are handled by the linter, not in review comments.

## Deployments

We deploy to production from the main branch, Monday to Thursday, between 09:00 and 15:00 UTC. There are no deploys on Fridays unless it is a hotfix approved by the on-call engineer.

Every deploy runs database migrations first, then rolls out the API with zero downtime. If error rates rise above 2% within ten minutes, the pipeline rolls back automatically.

## On-call

On-call rotates weekly, starting Monday at 10:00 UTC. The on-call engineer responds to pages within 15 minutes and writes a short incident note for anything customer-facing. Postmortems are blameless and are due within five business days.

## Time off

Engineers get 25 days of paid leave per year, plus local public holidays. Leave longer than five consecutive days should be requested at least two weeks in advance so on-call can be rearranged.
