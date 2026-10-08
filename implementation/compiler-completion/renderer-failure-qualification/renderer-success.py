#!/usr/bin/env python3
import os,sys,time,json,signal
open('/Users/vince/Projects/canlang/implementation/compiler-completion/renderer-failure-qualification/success.pid',"w").write(str(os.getpid()))
data=json.load(sys.stdin)
assert "Gadget" in str(data)
print("# Reference")
