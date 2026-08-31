# Domain Docs

Before exploring the codebase, read:

- `CONTEXT.md` at the repository root, if it exists.
- Relevant ADRs under `docs/adr/`, if they exist.

Missing files should not be reported. The domain-modeling skill creates them lazily when domain terms or decisions are resolved.

## File structure

This is a single-context repository:

```
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

Use terminology defined in `CONTEXT.md`. Explicitly flag output that conflicts with an existing ADR.
