#!/usr/bin/env python3
"""Reusable TypeSafe/Jev caller. Uses only Python's standard library."""

import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


ENDPOINT = "https://api.typesafe.ai/v1/systemone"


def consult(request, *, timeout=55):
    """Make one request; return the response without retrying or hiding uncertainty."""
    if not isinstance(request, dict):
        raise ValueError("A request must be a JSON object")
    questions = request.get("questions")
    if not isinstance(questions, dict) or not questions or "state" not in request:
        raise ValueError("A request needs state and a nonempty questions object")
    for name, question in questions.items():
        if not isinstance(question, dict) or not question.get("type"):
            raise ValueError(f"Question {name} needs a type")
        if question["type"] == "choice" and not isinstance(question.get("criteria"), dict):
            raise ValueError(f"Choice question {name} needs a criteria object")
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key:
        raise ValueError("Set TYPESAFE_API_KEY in the environment")
    payload = {"model": "jev-latest", **request}
    outbound = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload, ensure_ascii=False, allow_nan=False).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(outbound, timeout=timeout) as reply:
            raw = reply.read().decode()
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        raise RuntimeError(f"Jev returned HTTP {status}; no retry was made") from None
    except (OSError, urllib.error.URLError):
        raise RuntimeError("Jev connection failed; no retry was made") from None
    response = json.loads(raw.replace(key, "[REDACTED]"))
    if not isinstance(response, dict) or not response.get("model"):
        raise ValueError("Jev response is missing its model")
    answers = response.get("answers")
    if not isinstance(answers, dict) or set(answers) != set(questions):
        raise ValueError("Jev response does not match the requested questions")
    for name, question in questions.items():
        answer = answers[name]
        if not isinstance(answer, dict) or answer.get("type") != question.get("type"):
            raise ValueError(f"Jev returned the wrong answer type for {name}")
        if question["type"] == "choice" and answer.get("choice") not in question["criteria"]:
            raise ValueError(f"Jev returned an unknown choice for {name}")
    return response


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path, help="JSON containing state and typed questions")
    parser.add_argument("--context", action="append", type=Path, default=[],
                        help="Attach this UTF-8 source file to the state; may be repeated")
    parser.add_argument("--output", type=Path, help="Save the complete request and response")
    args = parser.parse_args()
    try:
        request = json.loads(args.request.read_text())
        if not isinstance(request, dict):
            raise ValueError("A request must be a JSON object")
        request.setdefault("model", "jev-latest")
        if args.context:
            request["state"] = {
                "brief": request["state"],
                "files": {str(path): path.read_text() for path in args.context},
            }
        if args.output and args.output.exists():
            raise ValueError("Output already exists; choose a new filename")
        response = consult(request)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            key = os.environ.get("TYPESAFE_API_KEY", "").strip()
            evidence = json.dumps({"request": request, "response": response}, indent=2, ensure_ascii=False)
            args.output.write_text(evidence.replace(key, "[REDACTED]") + "\n")
            print(json.dumps({"saved": str(args.output), "model": response["model"],
                              "answers": response["answers"], "usage": response.get("usage")}))
        else:
            print(json.dumps(response, indent=2, ensure_ascii=False))
    except (ValueError, OSError, RuntimeError) as error:
        key = os.environ.get("TYPESAFE_API_KEY", "").strip()
        message = str(error).replace(key, "[REDACTED]") if key else str(error)
        print(f"jev: {message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
