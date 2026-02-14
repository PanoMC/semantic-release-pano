# semantic-release-pano

**semantic-release** plugin to publish resources (plugins/themes) to the Pano Resource System.

## Install

```bash
npm install semantic-release-pano -D
```

## Usage

The plugin can be configured in the **semantic-release** configuration file:

### Single Configuration

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

### Multiple Configurations (Deploy to multiple sites)

```json
{
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["semantic-release-pano", {
      "file": "dist/my-plugin.jar",
      "panoVersion": "1.0.0",
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
|__ | __ | __ | __|
| `configs` | `Array` | `undefined` | List of configurations for multiple deployments. |
| `resourceId` | `String` | **Required** | The UUID of the Pano resource to update. |
| `file` | `String` | **Required** | Path to the file to upload (e.g. `.jar` or `.zip`). |
| `panoVersion` | `String` | **Required** | The target Pano version this release is compatible with. |
| `panoUrl` | `String` | `https://api.panomc.com` | Base URL of the Pano API. |
| `tokenVar` | `String` | `PANO_TOKEN` | Name of the environment variable containing the API token. |

## Environment Variables

| Variable | Description |
|__ | __|
| `PANO_TOKEN` | **Required** (default). The API token for authentication. Can be customized with `tokenVar`. |
