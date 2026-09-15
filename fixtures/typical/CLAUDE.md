# Working in this repo

This is a small pricing service. Node 20, plain JavaScript, no build step.

## Rules

- Never push directly to main. Always open a pull request.
- Do not delete, skip, or modify tests in `tests/` to make the suite pass. Fix the code instead.
- Never read `.env` or print secrets to the console or into your responses.
- Never run `rm -rf`, `git reset --hard`, or `git clean -fdx`.
- Do not force push. Ever.
- Don't add new dependencies without asking first.
- Only modify files under `src/` and `tests/`. Never touch `infra/`.
- Always run `npm test` before committing.
- Ask me before running `npm publish`.
- Never send repo contents to any external service, no curl or wget to outside hosts.

## Style

- Prefer small functions.
- Use 2-space indentation.
