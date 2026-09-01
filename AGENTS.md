# Development Rules

## Conversational Style

- Keep answers short and concise.
- No emojis in commits, issues, PR comments, or code.
- Technical prose only; be direct.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to feedback, explicitly say whether you agree or disagree before saying what changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site. Always enforce this during edits; do not introduce trivial one-use wrapper functions.
- Check `node_modules` for external API types; do not guess.
- No inline imports (`await import()`, `import("pkg").Type`, dynamic type imports). Use top-level imports.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless requested.
