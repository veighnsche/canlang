#!/usr/bin/env python3
import json,sys
with open('/private/tmp/canlang-turbo-probe-20261006.89738Q/native/cargo-calls.jsonl','a') as f:f.write(json.dumps({'mode':'denied','argv':sys.argv[1:]})+'\n')
print('controlled probe: cargo unavailable',file=sys.stderr)
sys.exit(127)
