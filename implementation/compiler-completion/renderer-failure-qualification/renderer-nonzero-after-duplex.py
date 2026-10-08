#!/usr/bin/env python3
import os,sys,time,json,signal
open('/Users/vince/Projects/canlang/implementation/compiler-completion/renderer-failure-qualification/nonzero-after-duplex.pid',"w").write(str(os.getpid()))
sys.stdout.write("x"*393216)
sys.stdout.flush()
sys.stderr.write("b"*393216+"END-DETAIL")
sys.stderr.flush()
sys.stdin.read()
sys.exit(7)
