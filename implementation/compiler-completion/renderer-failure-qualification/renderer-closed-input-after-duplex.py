#!/usr/bin/env python3
import os,sys,time,json,signal
open('/Users/vince/Projects/canlang/implementation/compiler-completion/renderer-failure-qualification/closed-input-after-duplex.pid',"w").write(str(os.getpid()))
sys.stdout.write("x"*393216)
sys.stdout.flush()
sys.stderr.write("b"*393216)
sys.stderr.flush()
os.close(0)
time.sleep(15)
