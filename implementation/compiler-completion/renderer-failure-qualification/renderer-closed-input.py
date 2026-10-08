#!/usr/bin/env python3
import os,sys,time,json,signal
open('/Users/vince/Projects/canlang/implementation/compiler-completion/renderer-failure-qualification/closed-input.pid',"w").write(str(os.getpid()))
os.close(0)
time.sleep(15)
