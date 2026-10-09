# semantic-release-pano

**semantic-release** plugin to publish resources (plugins/themes) to the Pano Resource System.

## Install

```bash
npm install semantic-release-pano -D
```

## Usage

The plugin can be configured in the **semantic-release** configuration file:

### Single Configuration (File Upload)

```json
{
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["semantic-release-pano", {
      "resourceId": "YOUR_RESOURCE_UUID",
      "file": "dist/my-plugin.jar",
      "panoVersion": "1.0.0",
      "panoUrl": "https://api.panomc.com"
    }]
  ]
}
```

**How the file is sent.** The plugin first asks the store for a direct upload ticket
(`POST /v1/resources/<id>/versions/uploads`), PUTs the file to the presigned storage URL with exactly
the headers the ticket lists, then calls `.../complete`. The log says which path was used (the
presigned URL is never logged). If the store does not offer direct uploads (404 from an older
back-end, or 501 `DIRECT_UPLOAD_UNAVAILABLE`), the file is sent in a multipart body to
`POST /v1/resources/<id>/versions` as before. Real refusals (permission, file too large, version
exists, bad tag) fail the release and are never retried through the body route. If the PUT or
complete step fails after a ticket was issued, the ticket is aborted (best effort) and the release
fails. GitHub Link mode is unchanged.

### GitHub Link Mode (No Upload)

Instead of uploading the file, use the GitHub Release asset URL and SHA-256 hash.
This is ideal for **free resources** that are already published as GitHub Release assets — avoids duplicate uploads.

```json
{
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/github", {
      "assets": [{ "path": "build/libs/*.jar" }]
    }],
    ["semantic-release-pano", {
      "resourceId": "YOUR_RESOURCE_UUID",
      "file": "build/libs/my-plugin-${version}.jar",
      "panoVersion": "1.0.0",
      "useGitHubLink": true,
      "repositoryUrl": "https://github.com/YourOrg/your-repo.git"
    }]
  ]
}
```

> **Note:** When using `useGitHubLink`, the `@semantic-release/github` plugin should run **before** `semantic-release-pano` in the plugin list, so that the GitHub Release and its assets are created first.

### Multiple Configurations (Deploy to multiple sites)

```json
{
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/github", {
      "assets": [{ "path": "build/libs/*.jar" }]
    }],
    ["semantic-release-pano", {
      "file": "build/libs/my-plugin-${version}.jar",
      "panoVersion": "1.0.0",
      "useGitHubLink": true,
      "repositoryUrl": "https://github.com/YourOrg/your-repo.git",
      "configs": [
        {
          "resourceId": "RESOURCE_UUID_1",
          "panoUrl": "https://api.site1.com",
          "tokenVar": "PANO_TOKEN_SITE1"
        },
        {
          "resourceId": "RESOURCE_UUID_2",
          "panoUrl": "https://api.site2.com",
          "tokenVar": "PANO_TOKEN_SITE2"
        }
      ]
    }]
  ]
}
```

### Branch-Scoped Deployments

Restrict a config to specific release branches with the optional `branches`
field. Configs without `branches` continue to run on every release branch, so
existing setups keep working unchanged.

```json
{
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["semantic-release-pano", {
      "file": "build/libs/my-plugin-${version}.jar",
      "panoVersion": "1.0.0",
      "configs": [
        {
          "resourceId": "RESOURCE_UUID",
          "panoUrl": "https://api-dev.panomc.com",
          "tokenVar": "PANO_TOKEN",
          "branches": ["dev"]
        },
        {
          "resourceId": "RESOURCE_UUID",
          "panoUrl": "https://api.panomc.com",
          "tokenVar": "PANO_PROD_TOKEN",
          "branches": ["main"]
        }
      ]
    }]
  ]
}
```

With the above, a release from `dev` only hits `api-dev.panomc.com` and a
release from `main` only hits `api.panomc.com`. `verifyConditions` also skips
the inactive configs, so a missing `PANO_PROD_TOKEN` won't fail a `dev` build.

### Changelog Truncation

semantic-release-generated notes can balloon — especially on the first stable
release of a branch that aggregated many prereleases — and exceed the Pano
backend's `changelog` validation budget, resulting in a `BAD_REQUEST` reject.
By default the plugin truncates the notes to **6500 characters** (including a
trailing `...`) before sending. Override per-config with `maxChangelogLength`:

```json
{
  "configs": [
    {
      "resourceId": "...",
      "panoUrl": "https://api.panomc.com",
      "tokenVar": "PANO_PROD_TOKEN",
      "branches": ["main"],
      "maxChangelogLength": 6500
    }
  ]
}
```

A log line is emitted whenever truncation actually kicks in, so it's visible
in the release job's output if the cap clips real content.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `configs` | `Array` | `undefined` | List of configurations for multiple deployments. |
| `resourceId` | `String` | **Required** | The UUID of the Pano resource to update. |
| `file` | `String` | **Required** | Path to the file (e.g. `.jar` or `.zip`). Supports `${version}` substitution. |
| `panoVersion` | `String` | **Required** | The target Pano version this release is compatible with. |
| `panoUrl` | `String` | `https://api.panomc.com` | Base URL of the Pano API. |
| `tokenVar` | `String` | `PANO_TOKEN` | Name of the environment variable containing the API token. |
| `useGitHubLink` | `Boolean` | `false` | If `true`, sends the GitHub Release asset URL and SHA-256 hash instead of uploading the file. |
| `repositoryUrl` | `String` | — | GitHub repository URL (required when `useGitHubLink` is `true`). |
| `branches` | `Array<String>` | `undefined` | If set, the config only runs when the release branch name is in this list. Omit to run on every release branch (default). |
| `maxChangelogLength` | `Number` | `6500` | Upper bound (chars) for the `changelog` field sent to the Pano API. When `nextRelease.notes` exceeds this, the body is truncated to `maxChangelogLength` characters total — `...` suffix included — to stay under the receiving server's validation limit. |
| `apiLevel` | `Number` | read from the artifact | The Pano API level the release needs (a whole number, 1 or more), sent as the `apiLevel` field. Set it only for an artifact that carries no level of its own (for example the Minecraft plugin); when set, the artifact is not read. |
| `sendApiLevel` | `Boolean` | `false` | If `true`, the level is sent to the store as the `apiLevel` field. Off by default: a store that does not know the field yet refuses the publish (400). The level is read and required either way. |
| `requireApiLevel` | `Boolean` | `true` | If `false`, an artifact without an API level is published anyway (no `apiLevel` is sent, so the store records level 0 and never offers the version as compatible). |

## API level

Every Pano plugin and theme declares the API level it needs. The plugin reads it from the artifact itself, with the same rule the store uses for files uploaded on the website:

1. a jar: the `api-level` attribute in the main section of `META-INF/MANIFEST.MF`;
2. otherwise a zip: `apiLevel` in the root `manifest.json` (themes, custom apps).

The level is logged (`API level: N`) and sent as `apiLevel` with the upload or with the GitHub link, so the store can answer "the newest version your Pano can run".

### `EAPILEVEL`

`verifyConditions`/`publish` fails with `EAPILEVEL` ("artifact has no api-level: run "bunx @panomc/sdk pano-api migrate-v1" and rebuild") when the artifact carries no level and `requireApiLevel` is not `false`. What to do:

- A plugin or theme built for Pano: run `bunx @panomc/sdk pano-api migrate-v1` once in the repository, rebuild, and release again; the build then writes the level into the jar manifest or the theme's `manifest.json`.
- An artifact that is not a Pano plugin or theme and has no level to carry: set `apiLevel` in the configuration, or `requireApiLevel: false` to publish it as level 0.
- A bad `apiLevel` option (not a whole number of 1 or more) fails with `EINVALIDCONFIG`.

A version added by hand through the website form gets its level the same way: read from the uploaded file, else from the optional `apiLevel` form field, else 0.

## Environment Variables

| Variable | Description |
|---|---|
| `PANO_TOKEN` | **Required** (default). The API token for authentication. Can be customized with `tokenVar`. |

## How It Works

### Upload Mode (default)
1. Reads the local file
2. Uploads it to the Pano API as a multipart form

### GitHub Link Mode (`useGitHubLink: true`)
1. Reads the local file and computes its **SHA-256** hash
2. Builds the GitHub Release asset download URL from `repositoryUrl` and the release tag
3. Sends the **URL** and **hash** to the Pano API — no file upload

This is particularly useful for free resources: the file is already on GitHub Releases, so there's no need to upload it again to the Pano server.
