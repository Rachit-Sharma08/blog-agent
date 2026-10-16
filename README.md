# blog-agent

Generates ONE new blog-post draft; only `--save` inserts it into Supabase as an unpublished
row (`published=false`, `published_at=null`). Publishing always stays a human decision.

No dependencies - plain Node `fetch` talks to Supabase, Gemini, and OpenRouter (fallback).
Default mode is a dry run: the draft is printed, nothing is written.

## Dry run (keep the env file OUTSIDE this repo)

Copy `.env.example` somewhere outside this repo, fill it in, then run:

    node --env-file=../blog-agent-secrets.env generate-draft.mjs

`.env` is gitignored at any depth and **must never be committed** - only `.env.example` is tracked.