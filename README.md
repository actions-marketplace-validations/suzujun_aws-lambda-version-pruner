# AWS Lambda Version Pruner Action

This GitHub Action prunes published AWS Lambda versions using count-based (`keep-latest`) and age-based (`older-than-days`) rules.
The action runs as a JavaScript action on `node24`.

## Features

- Operates on a single Lambda function per run
- Supports using `keep-latest` and `older-than-days` together (OR condition)
- Supports `dry-run` mode to preview deletion candidates (default: `false`)
- Excludes alias-referenced versions by default

## Required Permissions

This action assumes AWS credentials are configured by the caller workflow via OIDC.

Required IAM permissions:

- `lambda:ListVersionsByFunction`
- `lambda:ListAliases`
- `lambda:DeleteFunction`

Minimum GitHub Actions permissions:

- `id-token: write`
- `contents: read`

## Inputs

| Name                      | Required | Type                     | Default | Description                                         |
| ------------------------- | -------- | ------------------------ | ------- | --------------------------------------------------- |
| `function-name`           | Yes      | string                   | -       | Target Lambda function name                         |
| `aws-region`              | Yes      | string                   | -       | Target AWS region                                   |
| `keep-latest`             | No       | integer (`>= 0`)         | -       | Keep the latest N versions                          |
| `older-than-days`         | No       | integer (`>= 1`)         | -       | Select versions older than N days                   |
| `dry-run`                 | No       | boolean (`true`/`false`) | `false` | If `true`, only print candidates without deleting   |
| `delete-aliased-versions` | No       | boolean (`true`/`false`) | `false` | If `true`, allow deleting alias-referenced versions |

Notes:

- At least one of `keep-latest` or `older-than-days` is required.
- If both are provided, a version is selected when either condition matches (OR).
- `$LATEST` is never deleted.

## Outputs

| Name                | Type                | Description                                            |
| ------------------- | ------------------- | ------------------------------------------------------ |
| `total-versions`    | string (number)     | Total number of published versions excluding `$LATEST` |
| `selected-count`    | string (number)     | Number of selected deletion candidates                 |
| `deleted-count`     | string (number)     | Number of versions actually deleted                    |
| `selected-versions` | string (JSON array) | JSON array of selected version numbers                 |
| `deleted-versions`  | string (JSON array) | JSON array of deleted version numbers                  |

## Example

```yaml
name: prune-lambda-versions

on:
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  prune:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-oidc-role
          aws-region: ap-northeast-1

      - name: Prune lambda versions
        uses: suzujun/aws-lambda-version-pruner@v1
        with:
          function-name: my-lambda-function
          aws-region: ap-northeast-1
          keep-latest: "10"
          older-than-days: "30"
          dry-run: "false"
          delete-aliased-versions: "false"
```
