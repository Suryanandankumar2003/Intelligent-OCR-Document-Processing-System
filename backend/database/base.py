"""
Declarative base class that every SQLAlchemy ORM model will inherit from.

Kept in its own module (rather than inside session.py or a models.py) so
that models can import `Base` without also importing the engine/session
machinery, avoiding circular imports once real models are added.
"""
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
