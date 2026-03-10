---
description: Commit changes using conventional commit format with bullet points
---

# Git Commit Skill

Commit staged changes following the project's conventional commit format.

## Instructions

1. Run `git status` to see all untracked and modified files
2. Run `git diff` to see unstaged changes
3. Run `git diff --staged` to see staged changes
4. Analyze the changes and draft a commit message

## Commit Format

```
<type>: <short description>

- Change 1
- Change 2
- Change 3
```

## Commit Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

## Rules

1. **Short description**: Concise summary (50 chars max recommended)
2. **Bullet points**: List each change with `-` prefix
3. **Present tense**: Use "Add" not "Added" in short description
4. **No period**: Don't end the short description with a period
5. **Capitalize**: Capitalize the first letter of the short description

## Execution Steps

1. Stage relevant files with `git add <files>`
2. Create commit with the formatted message
3. Run `git push` to push to remote
4. Run `git status` to verify success

## Example

```bash
git commit -m "feat: Add collapsible sidebar

- Added toggle button in sidebar header
- Implemented CSS transitions for smooth collapse
- Persisted collapsed state in localStorage
- Added collapsed sidebar styles (36px width)"
```
