#!/usr/bin/env python3
import os,sys,time,json,signal
open('/Users/vince/Projects/canlang/implementation/compiler-completion/renderer-failure-qualification/duplex.pid',"w").write(str(os.getpid()))
sys.stdout.write("x"*262144)
sys.stdout.flush()
sys.stderr.write("startup-note"*32768)
sys.stderr.flush()
sys.stdin.read()
print("# Reference")
