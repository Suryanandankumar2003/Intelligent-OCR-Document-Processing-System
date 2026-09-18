"""Prompt templates, grouped by the feature that sends them to Vertex AI.

Kept as their own package so a prompt's wording can be found and tuned
without wading through the service code that calls it, and so future
features (e.g. summarization) get an obvious place to add their own
template module alongside `classification_prompt.py`.
"""
