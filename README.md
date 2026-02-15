# vibectl Run - GitHub Action

Execute Claude Code tasks via the vibectl platform directly in your GitHub Actions workflows. Enable AI-powered code analysis, reviews, and automation in your CI/CD pipelines.

## Features

- **CI/CD Integration**: Run Claude Code tasks as part of your GitHub Actions workflows
- **Real-Time Streaming**: Live output via Server-Sent Events (SSE) for immediate feedback
- **Structured Outputs**: Access task results, IDs, duration, and cost for workflow composition
- **Error Handling**: Graceful failure modes with clear error messages
- **Cost Tracking**: Monitor API usage with built-in cost reporting

## Prerequisites

1. **vibectl Account**: Sign up at [vibectl.dev](https://vibectl.dev)
2. **API Key**: Generate an API key from your vibectl dashboard
3. **GitHub Secret**: Store your API key as `VIBECTL_API_KEY` in repository secrets

### Setting up GitHub Secrets

1. Navigate to your repository Settings > Secrets and variables > Actions
2. Click "New repository secret"
3. Name: `VIBECTL_API_KEY`
4. Value: Your vibectl API key
5. Click "Add secret"

## Usage

### Basic Example

```yaml
name: Code Review

on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run vibectl code review
        id: vibectl
        uses: vibectl/run@v1
        with:
          api-key: ${{ secrets.VIBECTL_API_KEY }}
          prompt: |
            Review this pull request for code quality,
            security issues, and best practices.

      - name: Display results
        run: |
          echo "Result: ${{ steps.vibectl.outputs.result }}"
          echo "Duration: ${{ steps.vibectl.outputs.duration-ms }}ms"
```

### Advanced Example with Custom Timeout

```yaml
- name: Security analysis
  uses: vibectl/run@v1
  with:
    api-key: ${{ secrets.VIBECTL_API_KEY }}
    prompt: Perform comprehensive security audit
    timeout: 900  # 15 minutes
```

### Using Outputs in Subsequent Steps

```yaml
- name: Run analysis
  id: analysis
  uses: vibectl/run@v1
  with:
    api-key: ${{ secrets.VIBECTL_API_KEY }}
    prompt: Analyze codebase architecture

- name: Comment on PR
  if: steps.analysis.outputs.result == 'completed'
  uses: actions/github-script@v7
  with:
    script: |
      github.rest.issues.createComment({
        issue_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
        body: `## Analysis Results\n\n${{ steps.analysis.outputs.output }}`
      })
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | Yes | - | vibectl API key (use GitHub secrets) |
| `prompt` | Yes | - | The prompt/command to execute with Claude Code |
| `api-url` | No | `https://api.vibectl.dev` | vibectl API endpoint URL |
| `timeout` | No | `1800` | Maximum execution time in seconds (30 minutes) |

## Outputs

| Output | Description |
|--------|-------------|
| `result` | Task execution result: `completed`, `failed`, or `timeout` |
| `task-id` | Unique task identifier for tracking |
| `duration-ms` | Task execution duration in milliseconds |
| `cost-usd` | Estimated cost in USD (if available) |
| `output` | Task output or error message |

## Example Workflows

See the [`examples/`](./examples/) directory for complete workflow examples:

- **[basic-usage.yml](./examples/basic-usage.yml)**: Simple code review workflow
- **[advanced-usage.yml](./examples/advanced-usage.yml)**: Multiple jobs with custom configurations

## How It Works

1. **Task Submission**: The action calls `POST /v1/tasks` on the vibectl API with your prompt and repository context
2. **Ephemeral Container Execution**: The platform provisions an isolated container, clones your repository, and runs Claude Code with full access to your codebase and `.claude/` configuration
3. **Real-Time Streaming**: The action connects to `GET /v1/tasks/:id/stream` for live SSE output
4. **Live Output**: stdout/stderr streams directly to workflow logs as execution progresses
5. **Completion**: Returns structured outputs when the task completes or times out

### Execution Model

The vibectl Action submits tasks via the public REST API. The platform executes all tasks -- whether triggered by the GitHub Action, GitHub App, or direct API call -- using the same ephemeral container model:

- The platform provisions an isolated container and clones your repository
- Claude Code runs inside the container with access to your codebase and `.claude/` configuration
- Containers scale to zero after task completion (no persistent infrastructure)
- The action receives real-time output via Server-Sent Events (SSE)

This architecture provides strong isolation between customers and consistent behavior across all integration methods.

## Error Handling

The action handles various failure scenarios:

- **Timeout**: Task exceeds configured timeout (default 30 minutes)
- **API Errors**: Network failures or API unavailability
- **Task Failures**: Claude Code execution errors
- **Authentication**: Invalid or expired API keys

Example with error handling:

```yaml
- name: Run analysis
  id: analysis
  uses: vibectl/run@v1
  continue-on-error: true
  with:
    api-key: ${{ secrets.VIBECTL_API_KEY }}
    prompt: Analyze codebase

- name: Handle failure
  if: steps.analysis.outputs.result == 'failed'
  run: |
    echo "Analysis failed: ${{ steps.analysis.outputs.output }}"
    # Send notification, create issue, etc.
```

## Security Considerations

- **API Key Storage**: Always use GitHub secrets, never hardcode keys
- **Credential Redaction**: The action automatically redacts credentials from error messages
- **Rate Limiting**: API enforces rate limits per key
- **Timeout Protection**: Client-side timeout prevents indefinite execution

## Limitations

- **Maximum Timeout**: 24 hours (86,400 seconds)
- **Prompt Size**: 10KB maximum
- **Payload Size**: 100KB maximum total payload

## Troubleshooting

### Action times out immediately

Check that your `timeout` input is set appropriately for your task complexity. Default is 30 minutes.

### Authentication failed

Verify your `VIBECTL_API_KEY` secret is correctly configured and not expired.

### Task stuck in "queued" status

Check vibectl platform status. May indicate high load or infrastructure issues.

### Cost tracking not available

Cost information is only available after task completion. Check `cost-usd` output.

## Development

To build this action locally:

```bash
pnpm install
pnpm build
```

The bundled output is in `dist/index.js`.

## Support

- **Documentation**: [docs.vibectl.dev](https://docs.vibectl.dev)
- **Issues**: [GitHub Issues](https://github.com/vibectl/run/issues)
- **Email**: support@vibectl.dev

## License

MIT License - see [LICENSE](./LICENSE) for details.
