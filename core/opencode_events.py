"""Validate OpenCode JSONL output and extract resumable assistant responses."""
import json


def parse_events(output: str, expected_session: str | None = None) -> tuple[str, str]:
    session = None
    texts = []
    if not output.strip():
        raise ValueError('OpenCode emitted no events')
    for number, line in enumerate(output.splitlines(), 1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f'Invalid OpenCode event on line {number}: {exc.msg}') from exc
        if not isinstance(event, dict) or not isinstance(event.get('type'), str):
            raise ValueError(f'Invalid OpenCode event on line {number}')
        identity = event.get('sessionID')
        if not isinstance(identity, str) or not identity:
            raise ValueError(f'Missing OpenCode session ID on line {number}')
        if session is not None and session != identity:
            raise ValueError('OpenCode emitted multiple session IDs')
        session = identity
        if event['type'] == 'text':
            part = event.get('part')
            if not isinstance(part, dict) or part.get('type') != 'text' or not isinstance(part.get('text'), str):
                raise ValueError(f'Invalid OpenCode text event on line {number}')
            texts.append(part['text'])
    if expected_session is not None and session != expected_session:
        raise ValueError('OpenCode returned unexpected session ID')
    if not texts or not any(text.strip() for text in texts):
        raise ValueError('OpenCode emitted no assistant text')
    return session, '\n'.join(texts)
