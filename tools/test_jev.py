import io
import json
import unittest
from unittest.mock import patch
import urllib.error

import jev


class JevCallerTests(unittest.TestCase):
    request = {"state": "Evidence", "questions": {"q": {
        "type": "choice", "instructions": "Choose", "criteria": {"a": "A", "b": "B"}}}}

    def invoke(self, response):
        with patch.dict(jev.os.environ, {"TYPESAFE_API_KEY": "test-secret"}), \
             patch.object(jev.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(response).encode())) as remote:
            result = jev.consult(self.request)
            sent = remote.call_args.args[0]
            self.assertEqual(sent.get_header("Authorization"), "Bearer test-secret")
            self.assertEqual(json.loads(sent.data)["model"], "jev-latest")
            self.assertEqual(json.loads(sent.data)["questions"], self.request["questions"])
            return result

    def test_preserves_uncertain_answers(self):
        response = {"model": "jev-test", "answers": {"q": {
            "type": "choice", "choice": "a", "confidence": 0.01,
            "probabilities": {"a": 0.51, "b": 0.49}}}}
        self.assertEqual(self.invoke(response), response)

    def test_rejects_missing_or_invented_answer(self):
        for answers in ({}, {"q": {"type": "choice", "choice": "invented"}}):
            with self.subTest(answers=answers), self.assertRaises(ValueError):
                self.invoke({"model": "jev-test", "answers": answers})

    def test_http_failure_is_not_retried_or_echoed(self):
        error = urllib.error.HTTPError(jev.ENDPOINT, 429, "test-secret", {}, io.BytesIO(b"test-secret"))
        with patch.dict(jev.os.environ, {"TYPESAFE_API_KEY": "test-secret"}), \
             patch.object(jev.urllib.request, "urlopen", side_effect=error) as remote:
            with self.assertRaisesRegex(RuntimeError, "HTTP 429") as caught:
                jev.consult(self.request)
            self.assertNotIn("test-secret", str(caught.exception))
            self.assertEqual(remote.call_count, 1)


if __name__ == "__main__":
    unittest.main()
