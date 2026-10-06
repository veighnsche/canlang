#!/usr/bin/env python3
import json,os,sys
with open('/private/tmp/canlang-turbo-probe-20261006.89738Q/native/cargo-calls.jsonl','a') as f:f.write(json.dumps({'mode':'offline','argv':sys.argv[1:]})+'\n')
args=sys.argv[1:]
if 'metadata' in args and '--offline' not in args:args.append('--offline')
os.execv('/Users/vince/.cargo/bin/cargo',['/Users/vince/.cargo/bin/cargo']+args)
