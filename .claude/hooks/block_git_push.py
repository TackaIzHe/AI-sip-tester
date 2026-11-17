#!/usr/bin/env python3
"""Хук PreToolUse: запрещает запуск `git push` из Bash-команд.

Читает JSON события из stdin, ищет подстроку `git push` в тексте команды;
при обнаружении завершается с кодом 2 (блокировка, stderr показывается модели).
"""

import json
import sys


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0

    command = event.get("tool_input", {}).get("command", "")
    if "git push" in command:
        sys.stderr.write("git push запрещён политикой проекта\n")
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
