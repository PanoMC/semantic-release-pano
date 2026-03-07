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
