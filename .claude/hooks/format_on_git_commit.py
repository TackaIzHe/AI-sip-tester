#!/usr/bin/env python3
"""Хук PreToolUse: при попытке `git commit` прогоняет prettier по проекту.

Читает JSON события из stdin; если в тексте команды есть подстрока
`git commit`, выполняет `npm run format` в каталоге проекта. При успехе
молча пропускает запуск (подтверждение из permissions.ask остаётся);
при ошибке prettier блокирует команду кодом 2 с выводом в stderr.
"""

import json
import subprocess
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0

    command = event.get("tool_input", {}).get("command", "")
    if "git commit" not in command:
        return 0

    try:
        result = subprocess.run(
            ["npm", "run", "format"],
            cwd=str(PROJECT_DIR),
            capture_output=True,
            text=True,
            timeout=120,
        )
    except OSError as exc:
        sys.stderr.write("git commit заблокирован: prettier не запущен: %s\n" % exc)
        return 2
    except subprocess.TimeoutExpired:
        sys.stderr.write("git commit заблокирован: prettier не завершился за 120 с\n")
        return 2

    if result.returncode != 0:
        sys.stderr.write("git commit заблокирован: prettier завершился с ошибкой\n")
        sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
        return 2

    sys.stderr.write("prettier перед коммитом выполнен\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
