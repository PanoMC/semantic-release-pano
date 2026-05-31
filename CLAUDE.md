# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`semantic-release-pano` is a **custom [semantic-release](https://semantic-release.gitbook.io/)
plugin** that publishes a built Pano plugin/theme to the **Pano resource store** (the API served by
`website-back-end`). It is the last step in the release pipelines of Pano plugin/theme repos,
wired in via their `.releaserc`. Node.js, ISC-licensed, uses Axios + form-data. See `../CLAUDE.md`.

## How it's used

It implements semantic-release lifecycle hooks and supports two publish modes:

- **Upload** — POSTs the built jar/zip artifact to the Pano API.
- **GitHub link** (`useGitHubLink`) — references a GitHub release asset URL + its SHA-256 instead of
  uploading the file (used for free resources).

Config options include `resourceId`, `panoVersion`, `panoUrl`, `branches` (for
environment-specific channels), and `maxChangelogLength`. See `README.md` for the full option list.

## Commands

```bash
npm install      # peer dep: semantic-release >=19
# no test/build step is configured (the package is consumed directly by semantic-release)
```

## Conventions

- It is itself released via semantic-release → use **conventional commit** messages.
- Changing publish behavior here affects **every** plugin/theme release pipeline that depends on it
  — verify against a real `.releaserc` before changing the hook contract.
