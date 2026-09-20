# Working in this repository

This is the billing service. It is small, and the rules below are not negotiable.

- Never push directly to `main`. Open a pull request.
- Do not delete, skip, or weaken tests in `tests/` to make the suite pass. Fix the code.
- Never read `.env` or print secrets into your answers.
- Never run `rm -rf`, `git reset --hard`, or `git clean -fdx`.
- Do not force push.
- Always run `pytest` before committing.
- Only modify files under `app/` and `tests/`. Never touch `deploy/`.
- Do not add dependencies without asking.
- Never send repository contents to an external service.
