#!/usr/bin/env python3
import sys,json
with open('/private/tmp/canlang-review-cold-w1_65l61/calls.jsonl',"a") as f: f.write(json.dumps(sys.argv[1:])+"\n")
print("review cold cargo unavailable",file=sys.stderr)
sys.exit(127)
