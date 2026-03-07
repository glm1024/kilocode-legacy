from __future__ import annotations

from collections.abc import Generator

from fastapi import Request
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


def create_engine_and_session(database_url: str):
    connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    engine = create_engine(database_url, future=True, pool_pre_ping=True, connect_args=connect_args)
    session_local = sessionmaker(bind=engine, autocommit=False, autoflush=False, future=True)
    return engine, session_local


def get_db(request: Request) -> Generator[Session, None, None]:
    session_local = request.app.state.session_local
    db: Session = session_local()
    try:
        yield db
    finally:
        db.close()
