#!/usr/bin/env python3
import os,sys,time,json,signal
open('/Users/vince/Projects/canlang/implementation/compiler-completion/renderer-failure-qualification/signal.pid',"w").write(str(os.getpid()))
sys.stdin.read()
os.kill(os.getpid(), signal.SIGTERM)
