# scripts

## generate-github-activity.mjs

Builds the "GitHub Activity" section of the profile README from the official
GitHub GraphQL API. No dependencies, Node 20+.

```bash
# run locally (uses your gh login; read-only public data is requested)
GITHUB_TOKEN="$(gh auth token)" node scripts/generate-github-activity.mjs

# re-render even if the data has not changed
GITHUB_TOKEN="$(gh auth token)" node scripts/generate-github-activity.mjs --force
```

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | required | Read-only token. In Actions this is the built-in `secrets.GITHUB_TOKEN`. Never commit it. |
| `GITHUB_USER` | `najmulhasandev` | Profile to read |
| `OUT_DIR` | `assets/github-activity` | Where SVGs and `data.json` are written |
| `README_PATH` | `README.md` | Only the block between the `github-activity` markers is rewritten |

If GitHub fails or rejects the token, the script exits non-zero before writing
anything, so the last committed graphics stay. `.github/workflows/github-activity.yml`
runs it every 6 hours and commits only when the data changed.
