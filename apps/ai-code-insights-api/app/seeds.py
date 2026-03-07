from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .models import AppSetting
from .schemas import AISettingsPayload
from .services.ai import AI_SETTINGS_KEY
from .utils.encryption import SettingsCipher

BOOTSTRAP_META_KEY = "bootstrap_meta"


def seed_preset_data(db: Session, settings: Settings, cipher: SettingsCipher) -> None:
    seed_keys = [AI_SETTINGS_KEY, BOOTSTRAP_META_KEY]
    existing_rows = {
        row.setting_key: row
        for row in db.scalars(select(AppSetting).where(AppSetting.setting_key.in_(seed_keys))).all()
    }

    ai_settings_row = existing_rows.get(AI_SETTINGS_KEY)
    if not ai_settings_row:
        payload = _resolve_seed_ai_settings(settings)
        db.add(
            AppSetting(
                setting_key=AI_SETTINGS_KEY,
                setting_value=cipher.encrypt_json(payload.model_dump(mode="json")),
                encrypted=True,
            )
        )

    bootstrap_meta_row = existing_rows.get(BOOTSTRAP_META_KEY)
    if not bootstrap_meta_row:
        meta_payload = {
            "seedVersion": settings.bootstrap_seed_version,
            "initializedAt": datetime.now(timezone.utc).isoformat(),
            "appName": settings.app_name,
        }
        db.add(
            AppSetting(
                setting_key=BOOTSTRAP_META_KEY,
                setting_value=json.dumps(meta_payload, ensure_ascii=False, sort_keys=True),
                encrypted=False,
            )
        )
    else:
        current_meta = _parse_bootstrap_meta(bootstrap_meta_row.setting_value)
        if (
            current_meta.get("seedVersion") != settings.bootstrap_seed_version
            or current_meta.get("appName") != settings.app_name
        ):
            current_meta["seedVersion"] = settings.bootstrap_seed_version
            current_meta["appName"] = settings.app_name
            current_meta["initializedAt"] = current_meta.get("initializedAt") or datetime.now(timezone.utc).isoformat()
            bootstrap_meta_row.setting_value = json.dumps(current_meta, ensure_ascii=False, sort_keys=True)
            bootstrap_meta_row.encrypted = False

    db.commit()


def _resolve_seed_ai_settings(settings: Settings) -> AISettingsPayload:
    if settings.seed_ai_settings_json:
        try:
            return AISettingsPayload.model_validate_json(settings.seed_ai_settings_json)
        except Exception as exc:  # pragma: no cover - validation details vary
            raise ValueError("SEED_AI_SETTINGS_JSON is not valid AISettingsPayload JSON.") from exc

    return AISettingsPayload(defaultProfile=None, profiles=[])


def _parse_bootstrap_meta(raw_value: str) -> dict[str, str]:
    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError:
        return {}

    if isinstance(parsed, dict):
        return {str(key): str(value) for key, value in parsed.items()}
    return {}
