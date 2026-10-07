#!/usr/bin/env python3
import os,pty,select,subprocess,time,pathlib
master,slave=pty.openpty()
p=subprocess.Popen(['/bin/zsh','-f'],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
def drain(seconds):
 data=b'';until=time.monotonic()+seconds
 while time.monotonic()<until:
  if select.select([master],[],[],0.1)[0]:
   try:data+=os.read(master,65536)
   except OSError:break
 return data
trans=drain(.3)
os.write(master,b'fpath=(/usr/share/zsh/5.9/functions); autoload -Uz compinit; compinit -D; PS1="READY> "; source /Users/vince/Projects/canlang/compiler/can-completions.zsh; compdef _can can; bindkey "^I" expand-or-complete;\n')
trans+=drain(1)
for line in [b'can completions b\t',b'\x15can lint --fix\t',b'\x15can check --format=j\t',b'\x15can check -- --f\t']:
 os.write(master,line);trans+=drain(.3)
os.write(master,b'\x15exit\n');trans+=drain(.3)
p.wait(timeout=2);os.close(master)
pathlib.Path('/Users/vince/Projects/canlang/docs/research/compiler-library-audit-20261006/pass9/cli/zsh-pty.txt').write_bytes(trans)
print(trans.decode(errors='replace'))
