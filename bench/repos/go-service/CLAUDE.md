# Contributing to the ingest service

- Never commit or push directly to `main`; every change goes through a pull request.
- Do not remove or skip tests to get a green build.
- Never read `.env`.
- No destructive git commands: no `reset --hard`, no `clean -fdx`.
- Never force push.
- Run `go test ./...` before committing.
- Never add a dependency without approval.
