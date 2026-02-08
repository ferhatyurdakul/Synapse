---
description: Git commit message format with conventional style
---

# Git Commit Format

Use this format for all git commits in this project.

## Format

```
<type>: <short description>

<detailed description with bullet points>
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

## Example

```bash
git commit -m "feat: Add user authentication system

- Added login/logout functionality
- Implemented JWT token handling
- Created user session management
- Added password encryption with bcrypt
- Fixed session timeout issues"
```

## Rules

1. **Short description**: Concise summary of the change (50 chars max recommended)
2. **Bullet points**: List each change with `-` prefix
3. **Present tense**: Use "Add" not "Added" in short description
4. **No period**: Don't end the short description with a period
5. **Capitalize**: Capitalize the first letter of the short description

## Multi-line Commit Command

```bash
git commit -m "<type>: <short description>

- Change 1
- Change 2
- Change 3"
```
