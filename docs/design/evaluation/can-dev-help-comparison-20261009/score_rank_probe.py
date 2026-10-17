#!/usr/bin/env python3
"""Validate and score saved Jev Choice responses against frozen probe labels."""

import json
import math
from pathlib import Path


HERE = Path(__file__).resolve().parent


def score(case, record):
    result = {"case": case["id"], "gold": case["gold"]}
    if "response" not in record:
        result.update({"status": "provider_unavailable", "displayed_id": None,
                       "error_class": record.get("error_class"),
                       "elapsed_ms": record.get("elapsed_ms")})
        return result
    request = record["request"]
    response = record["response"]
    criteria = request["questions"]["construct"]["criteria"]
    answer = response["answers"]["construct"]
    probabilities = answer["probabilities"]
    valid = (
        answer.get("type") == "choice"
        and answer.get("choice") in criteria
        and set(probabilities) == set(criteria)
        and all(isinstance(value, (int, float)) and math.isfinite(value)
                and 0 <= value <= 1 for value in probabilities.values())
        and abs(sum(probabilities.values()) - 1) <= 1e-6
        and isinstance(answer.get("confidence"), (int, float))
        and math.isfinite(answer["confidence"])
        and 0 <= answer["confidence"] <= 1
        and isinstance(response.get("model"), str)
        and isinstance(response.get("usage", {}).get("input_tokens"), int)
        and isinstance(response.get("usage", {}).get("output_tokens"), int)
    )
    if not valid:
        result.update({"status": "invalid_response", "displayed_id": None,
                       "elapsed_ms": record.get("elapsed_ms")})
        return result
    selected = answer["choice"]
    ranked = sorted(probabilities.values(), reverse=True)
    lead = ranked[0] - ranked[1]
    displayed = selected if (
        selected in case["candidates"]
        and probabilities[selected] >= 0.65
        and lead >= 0.20
        and answer["confidence"] >= 0.60
    ) else None
    result.update({
        "status": "valid",
        "raw_choice": selected,
        "raw_matches_gold": selected == case["gold"],
        "selected_probability": probabilities[selected],
        "lead": round(lead, 6),
        "confidence": answer["confidence"],
        "displayed_id": displayed,
        "wrong_displayed_suggestion": displayed is not None and displayed != case["gold"],
        "elapsed_ms": record["elapsed_ms"],
        "model": response["model"],
        "input_tokens": response["usage"]["input_tokens"],
        "output_tokens": response["usage"]["output_tokens"],
    })
    return result


def main():
    cases = json.loads((HERE / "cases.json").read_text())["cases"]
    observations = []
    for case in cases:
        path = HERE / "jev" / f"{case['id']}.json"
        if path.exists():
            observations.append(score(case, json.loads(path.read_text())))
        else:
            observations.append({"case": case["id"], "gold": case["gold"],
                                 "status": "not_run", "displayed_id": None})
    valid = [item for item in observations if item["status"] == "valid"]
    aggregate = {
        "cases": len(cases),
        "valid_responses": len(valid),
        "raw_gold_matches": sum(item["raw_matches_gold"] for item in valid) if valid else None,
        "displayed_recommendations": sum(item["displayed_id"] is not None for item in valid) if valid else None,
        "wrong_displayed_recommendations": sum(item["wrong_displayed_suggestion"] for item in valid) if valid else None,
        "jev_input_tokens": sum(item["input_tokens"] for item in valid) if valid else None,
        "jev_output_tokens": sum(item["output_tokens"] for item in valid) if valid else None,
        "jev_elapsed_ms": sum(item["elapsed_ms"] for item in valid) if valid else None,
    }
    (HERE / "rank-scores.json").write_text(json.dumps({
        "aggregate": aggregate, "observations": observations,
    }, indent=2) + "\n")
    print(json.dumps(aggregate))


if __name__ == "__main__":
    main()
