"""Checking JSON input (conference.json, a source's settings, events.json): every problem is collected,
so one run reports all of them."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Pattern, Type

HEX_COLOR = re.compile(r'^#(?:[0-9a-fA-F]{3}){1,2}$')


class ConfigError(ValueError):
    """The conference settings cannot be used."""


class Checker:
    def __init__(self) -> None:
        self.problems: List[str] = []

    def fail(self, message: str) -> None:
        self.problems.append(message)

    def done(self, heading: str = 'invalid conference config', error: Type[Exception] = ConfigError) -> None:
        if self.problems:
            raise error(f'{heading}:\n  ' + '\n  '.join(self.problems))

    def mapping(self, value: Any, where: str) -> Dict[str, Any]:
        if isinstance(value, dict):
            return value
        self.fail(f'{where} must be an object')
        return {}

    def optional_mapping(self, obj: Dict[str, Any], key: str, where: str = '') -> Dict[str, Any]:
        return {} if obj.get(key) is None else self.mapping(obj[key], f'{where}{key}')

    def text(self, obj: Dict[str, Any], key: str, where: str = '', allow_empty: bool = False) -> str:
        value = obj.get(key)
        if isinstance(value, str) and (value or allow_empty):
            return value
        self.fail(f'{where}{key} must be a {"" if allow_empty else "non-empty "}string')
        return ''

    def optional_text(self, obj: Dict[str, Any], key: str, where: str = '', allow_empty: bool = False) -> str:
        return '' if key not in obj else self.text(obj, key, where, allow_empty)

    def number(self, obj: Dict[str, Any], key: str, where: str = '', minimum: Optional[float] = None) -> float:
        value = obj.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and (minimum is None or value >= minimum):
            return value
        self.fail(f'{where}{key} must be a number' + ('' if minimum is None else f' of at least {minimum}'))
        return 0

    def flag(self, obj: Dict[str, Any], key: str, where: str = '') -> bool:
        """An optional true/false field (default false)."""
        value = obj.get(key, False)
        if isinstance(value, bool):
            return value
        self.fail(f'{where}{key} must be true or false')
        return False

    def strings(self, obj: Dict[str, Any], key: str, where: str = '') -> List[str]:
        value = obj.get(key)
        if isinstance(value, list) and all(isinstance(x, str) for x in value):
            return value
        self.fail(f'{where}{key} must be a list of strings')
        return []

    def optional_strings(self, obj: Dict[str, Any], key: str, where: str = '') -> List[str]:
        return [] if key not in obj else self.strings(obj, key, where)

    def items(self, obj: Dict[str, Any], key: str, where: str = '', allow_empty: bool = False) -> List[Dict[str, Any]]:
        value = obj.get(key)
        if isinstance(value, list) and (value or allow_empty) and all(isinstance(x, dict) for x in value):
            return value
        self.fail(f'{where}{key} must be a {"" if allow_empty else "non-empty "}list of objects')
        return []

    def regex(self, obj: Dict[str, Any], key: str, where: str = '', flags: int = 0) -> Pattern[str]:
        try:
            return re.compile(self.text(obj, key, where), flags)
        except re.error as exc:
            self.fail(f'{where}{key} is not a valid regular expression: {exc}')
            return re.compile(r'(?!)')

    def color(self, obj: Dict[str, Any], key: str, where: str = '') -> str:
        value = obj.get(key)
        if isinstance(value, str) and HEX_COLOR.match(value):
            return value
        self.fail(f'{where}{key} must be a hex color like "#0369a1"')
        return ''

    def known_keys(self, obj: Dict[str, Any], allowed: Any, where: str) -> None:
        for key in obj:
            if key not in allowed:
                self.fail(f'{where}: unknown field {key!r}')

    def unique(self, values: List[Any], what: str) -> None:
        seen = set()
        for value in values:
            if value in seen:
                self.fail(f'duplicate {what} {value!r}')
            seen.add(value)
