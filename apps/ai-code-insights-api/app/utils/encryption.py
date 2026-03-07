from __future__ import annotations

import json

from cryptography.fernet import Fernet


class SettingsCipher:
    def __init__(self, key: str) -> None:
        self._fernet = Fernet(key.encode("utf-8") if isinstance(key, str) else key)

    def encrypt_json(self, payload: dict) -> str:
        raw = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        return self._fernet.encrypt(raw).decode("utf-8")

    def decrypt_json(self, token: str) -> dict:
        raw = self._fernet.decrypt(token.encode("utf-8"))
        return json.loads(raw.decode("utf-8"))
