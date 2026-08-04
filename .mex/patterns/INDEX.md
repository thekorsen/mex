# Pattern Index

Lookup table for project-specific pattern files. Two patterns are registered, both for
extension points that were exercised repeatedly during the omp-integration work.

| Pattern | Use when |
|---------|----------|
| [add-mcp-tool.md](add-mcp-tool.md) | Adding or changing a tool in the `mex-mcp` server — the registrar shape, the `{error, projectRoot}` envelope, the stdout trap on a stdio transport, and the workspace link a green build does not prove |
| [add-drift-checker.md](add-drift-checker.md) | Adding a checker to `mex check` — the signature, wiring it into `runDriftCheck`, extending the `IssueCode` union, and choosing a severity against the CI gate |
