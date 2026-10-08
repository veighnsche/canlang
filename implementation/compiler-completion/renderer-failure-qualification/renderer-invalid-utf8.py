#!/usr/bin/env python3
import os,sys,time,json,signal
open('/Users/vince/Projects/canlang/implementation/compiler-completion/renderer-failure-qualification/invalid-utf8.pid',"w").write(str(os.getpid()))
sys.stdin.read()
sys.stdout.buffer.write(b"\xff")
