"""
The Celery side of the application: the app object, and the tasks that
run the document pipeline off the request thread.

Kept as its own package rather than a module beside `api/` because it is
a second entry point into the same codebase. `celery -A worker.celery_app`
imports this package in a process that has no FastAPI app, no routes and
no request lifecycle — only the service, database and core layers, which
is exactly the boundary this project's layering already draws (a service
takes plain data and returns plain data; `core/` never imports from
`database/`). That the worker can import what it needs without dragging
in `app.py` is a consequence of that discipline, not a coincidence.
"""
