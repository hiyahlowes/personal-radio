# PR Workflow

## Branch Strategy

- **Default working branch: `dev`** — all development work goes here
- **`ios-testing`** — iOS-specific fixes and experiments
- **`main`** — production only; NEVER push directly to main during development
- To publish to production:
  ```
  git checkout main && git merge dev && git push origin main
  ```
  then manually publish in Netlify dashboard

## Git Rules

- Always `git add -A && git pull --rebase` before push, NEVER `--force`
- After every push to main: manually publish in Netlify dashboard (Auto-Deploy is DISABLED)
- Never expose API keys with `VITE_` prefix in frontend bundle

## Stack

- React / Vite / TypeScript, Netlify Functions, ElevenLabs TTS, Anthropic Claude
- Full project context: see PR-CONTEXT.md
